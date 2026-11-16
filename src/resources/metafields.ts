import { assertNoUserErrors, paginate, type AdminClient } from "../shopify/client.js";
import { bulkMutation, bulkQuery, bulkThreshold, bulkTimeoutMs } from "../shopify/bulk.js";
import type { FetchOptions, Item, ResourceAdapter } from "./types.js";
import { variantKey, type RefNode } from "../refs.js";
import { reservedPrefix } from "./util.js";

/*
 * Metafield values, keyed by where they live:
 *   PRODUCT/<handle>/<namespace.key>, COLLECTION/<handle>/<namespace.key>,
 *   PRODUCTVARIANT/<product handle>/<option values>/<namespace.key>, SHOP/<namespace.key>
 * The owner is stored as a portable ref, so a value lands on the product, collection or variant
 * with the same handle (and option values) in the target, or on the target's shop. Reference
 * values (product, metaobject, file...) are remapped like everywhere else.
 */

/** Owner types metafield values are read for, in the order they are read. */
export const VALUE_OWNER_TYPES = ["PRODUCT", "COLLECTION", "PRODUCTVARIANT", "SHOP"] as const;

const OWNERS = [
  { type: "PRODUCT", field: "products", byHandle: "productByIdentifier", page: 5 },
  { type: "COLLECTION", field: "collections", byHandle: "collectionByIdentifier", page: 5 },
] as const;

const OWNER_FIELDS = /* GraphQL */ `
  id
  handle
  metafields(first: 100, namespace: $namespace) {
    nodes { namespace key type value }
    pageInfo { hasNextPage }
  }
`;

const byHandle = (lookup: string) => /* GraphQL */ `
  query MetafieldValuesOf($handle: String!, $namespace: String) {
    ${lookup}(identifier: { handle: $handle }) { ${OWNER_FIELDS} }
  }
`;

const query = (owner: string, size: number) => /* GraphQL */ `
  query MetafieldValues($after: String, $namespace: String) {
    ${owner}(first: ${size}, after: $after) {
      nodes { ${OWNER_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

type Metafields = { nodes: { namespace: string; key: string; type: string; value: string }[]; pageInfo: { hasNextPage: boolean } };

interface OwnerNode {
  id: string;
  handle: string;
  metafields: Metafields;
}

interface VariantNode {
  id: string;
  selectedOptions: { name: string; value: string }[];
  product: { handle: string };
  metafields: Metafields;
}

const METAFIELDS = /* GraphQL */ `
  metafields(first: 100, namespace: $namespace) {
    nodes { namespace key type value }
    pageInfo { hasNextPage }
  }
`;

const SHOP_QUERY = /* GraphQL */ `
  query ShopMetafields($namespace: String) {
    shop { id ${METAFIELDS} }
  }
`;

// 8 variants with up to 100 metafields each stays under the cost limit of one request.
const VARIANTS_QUERY = /* GraphQL */ `
  query VariantMetafields($after: String, $namespace: String, $query: String) {
    productVariants(first: 8, after: $after, query: $query) {
      nodes { id selectedOptions { name value } product { handle } ${METAFIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PRODUCT_ID = /* GraphQL */ `
  query ProductIdOf($handle: String!) {
    productByIdentifier(identifier: { handle: $handle }) { id }
  }
`;

/** Namespaces that belong to apps or to Shopify's standard product taxonomy. */
function skipNamespace(ns: string): string | undefined {
  return reservedPrefix(ns) ?? (ns === "shopify" ? "Shopify standard (category) metafield" : undefined);
}

export function metafieldItems(ownerType: string, owner: OwnerNode, namespaces?: string[]) {
  return itemsOf(`${ownerType}/${owner.handle}`, owner, namespaces);
}

/** Items for the metafields of one owner; `prefix` is the owner part of their keys. */
function itemsOf(prefix: string, owner: { id: string; metafields: Metafields }, namespaces?: string[]) {
  const items: Item[] = [];
  const skipped: { key: string; reason: string }[] = [];
  for (const m of owner.metafields.nodes) {
    const key = `${prefix}/${m.namespace}.${m.key}`;
    if (namespaces?.length && !namespaces.includes(m.namespace)) continue;
    const reason = skipNamespace(m.namespace);
    if (reason) {
      skipped.push({ key, reason });
      continue;
    }
    items.push({ key, id: owner.id, data: { owner: owner.id, namespace: m.namespace, key: m.key, type: m.type, value: m.value } });
  }
  if (owner.metafields.pageInfo.hasNextPage) {
    skipped.push({ key: `${prefix}/*`, reason: "more than 100 metafields; only the first 100 were read (filter with namespaces)" });
  }
  return { items, skipped };
}

const BULK_SET = /* GraphQL */ `
  mutation BulkMetafieldsSet($m: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $m) { metafields { id } userErrors { field message code } }
  }
`;

async function set({ client }: Parameters<ResourceAdapter["create"]>[0], d: Record<string, unknown>): Promise<string> {
  const res = await client.request(
    `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { id } userErrors { field message code } } }`,
    { m: [{ ownerId: d.owner, namespace: d.namespace, key: d.key, type: d.type, value: d.value }] },
  );
  assertNoUserErrors(res.metafieldsSet, `metafieldsSet ${String(d.namespace)}.${String(d.key)}`);
  return res.metafieldsSet.metafields[0]?.id ?? "";
}

const nsArg = (namespace: string | undefined) => (namespace ? `(namespace: ${JSON.stringify(namespace)})` : "");

/** Rebuild owners from bulk rows: each metafield row follows with its owner's id in __parentId. */
function ownersFromBulk<T extends { id: string; metafields: Metafields }>(rows: Record<string, any>[]): T[] {
  const byId = new Map<string, T>();
  for (const r of rows) if (!r.__parentId) byId.set(r.id, { ...r, metafields: { nodes: [], pageInfo: { hasNextPage: false } } } as unknown as T);
  for (const r of rows) {
    const o = r.__parentId && byId.get(r.__parentId);
    if (o) o.metafields.nodes.push({ namespace: r.namespace, key: r.key, type: r.type, value: r.value });
  }
  return [...byId.values()];
}

const productCount = async (client: AdminClient) =>
  (await client.request<{ productsCount: { count: number } | null }>(`query { productsCount(limit: null) { count } }`)).productsCount?.count ?? 0;

/** Every product (or every variant) with its metafields, in one bulk operation: for large catalogs. */
function bulkProducts(client: AdminClient, namespace: string | undefined): Promise<OwnerNode[]> {
  const q = `{ products { edges { node { id handle metafields${nsArg(namespace)} { edges { node { namespace key type value } } } } } } }`;
  return bulkQuery(client, q, { timeoutMs: bulkTimeoutMs() }).then((rows) => ownersFromBulk<OwnerNode>(rows));
}
function bulkVariants(client: AdminClient, namespace: string | undefined): Promise<VariantNode[]> {
  const q = `{ productVariants { edges { node { id selectedOptions { name value } product { handle } metafields${nsArg(namespace)} { edges { node { namespace key type value } } } } } } }`;
  return bulkQuery(client, q, { timeoutMs: bulkTimeoutMs() }).then((rows) => ownersFromBulk<VariantNode>(rows));
}

async function readOwners(
  client: AdminClient,
  owner: (typeof OWNERS)[number],
  namespace: string | undefined,
  named: FetchOptions["metafieldOwners"],
): Promise<OwnerNode[]> {
  const handles = named?.[owner.type];
  // Many named owners (a plan's check before writing, say) read like a full read, then filtered.
  if (!named || (handles?.length ?? 0) > bulkThreshold()) {
    const all =
      owner.type === "PRODUCT" && (await productCount(client)) > bulkThreshold()
        ? await bulkProducts(client, namespace)
        : await paginate<OwnerNode>(client, query(owner.field, owner.page), { namespace }, (d) => d[owner.field]);
    if (!named) return all;
    const wanted = new Set(handles);
    return all.filter((o) => wanted.has(o.handle));
  }
  const found = await Promise.all(
    (handles ?? []).map(async (handle) => (await client.request<Record<string, OwnerNode | null>>(byHandle(owner.byHandle), { handle, namespace }))[owner.byHandle]),
  );
  return found.filter((n): n is OwnerNode => Boolean(n));
}

/** Variants with their metafields: every variant, or the variants of the named products. */
async function readVariants(client: AdminClient, namespace: string | undefined, handles: string[] | undefined): Promise<VariantNode[]> {
  const pick = (d: any) => d.productVariants;
  if (!handles || handles.length > bulkThreshold()) {
    const all =
      (await productCount(client)) > bulkThreshold()
        ? await bulkVariants(client, namespace)
        : await paginate<VariantNode>(client, VARIANTS_QUERY, { namespace }, pick);
    if (!handles) return all;
    const wanted = new Set(handles);
    return all.filter((v) => wanted.has(v.product.handle));
  }
  const lists = await Promise.all(
    handles.map(async (handle) => {
      const id = (await client.request<{ productByIdentifier: { id: string } | null }>(PRODUCT_ID, { handle })).productByIdentifier?.id;
      if (!id) return [];
      return paginate<VariantNode>(client, VARIANTS_QUERY, { namespace, query: `product_id:${id.split("/").pop()}` }, pick);
    }),
  );
  return lists.flat();
}

export const metafields: ResourceAdapter = {
  kind: "metafields",
  description:
    "Metafield values on products, collections, product variants and the shop, keyed by PRODUCT/handle/namespace.key, COLLECTION/handle/..., PRODUCTVARIANT/product-handle/option values/... and SHOP/namespace.key. Matched to the item with the same handle (and option values) in the target. Opt-in (not in the default set).",

  async fetch(client, opts, mapper) {
    const items: Item[] = [];
    const skipped: { key: string; reason: string }[] = [];
    const add = (r: { items: Item[]; skipped: typeof skipped }) => {
      items.push(...r.items);
      skipped.push(...r.skipped);
    };
    const namespace = opts.namespaces?.length === 1 ? opts.namespaces[0] : undefined;
    const named = opts.metafieldOwners;
    // owner_types narrows which owners are read; the include patterns can narrow it further
    // ("PRODUCT/linen-shirt/*" reads that product only, not the whole catalog).
    const wanted = (t: (typeof VALUE_OWNER_TYPES)[number]) =>
      (!opts.ownerTypes?.length || opts.ownerTypes.includes(t)) && (!named || (t === "SHOP" ? Boolean(named.SHOP) : Boolean(named[t]?.length)));

    const [lists, variants, shop] = await Promise.all([
      Promise.all(OWNERS.map((owner) => (wanted(owner.type) ? readOwners(client, owner, namespace, named) : Promise.resolve([])))),
      wanted("PRODUCTVARIANT") ? readVariants(client, namespace, named?.PRODUCTVARIANT) : Promise.resolve([]),
      wanted("SHOP") ? client.request<{ shop: { id: string; metafields: Metafields } }>(SHOP_QUERY, { namespace }) : Promise.resolve(undefined),
    ]);
    // The owners are known already: tell the ref mapper, so it doesn't look thousands of them up again.
    OWNERS.forEach((owner, i) => {
      for (const n of lists[i]!) {
        mapper?.seed({ __typename: owner.type === "PRODUCT" ? "Product" : "Collection", id: n.id, handle: n.handle } as RefNode);
        add(metafieldItems(owner.type, n, opts.namespaces));
      }
    });
    for (const v of variants) {
      mapper?.seed({ __typename: "ProductVariant", id: v.id, product: { handle: v.product.handle }, selectedOptions: v.selectedOptions });
      const options = variantKey(Object.fromEntries(v.selectedOptions.map((o) => [o.name, o.value])));
      add(itemsOf(`PRODUCTVARIANT/${v.product.handle}/${options}`, v, opts.namespaces));
    }
    if (shop) add(itemsOf("SHOP", shop.shop, opts.namespaces));
    return { items, skipped };
  },

  parallel: true,

  conflict(source, target) {
    if (source.data.type !== target.data.type) {
      return `type differs (${String(target.data.type)} in target, ${String(source.data.type)} in source)`;
    }
    return undefined;
  },

  ownerRef: (d) => (typeof d.owner === "string" ? d.owner : undefined),

  // Up to 25 values per metafieldsSet, one bulk operation for all of them.
  async bulkWrite(ctx, items) {
    const results: { id?: string; error?: string }[] = items.map(() => ({}));
    let pending = items.map((_, i) => i);
    // metafieldsSet writes all values of a call or none: values held back by another one's error go again.
    for (let round = 0; round < 3 && pending.length; round++) {
      const groups: number[][] = [];
      for (let i = 0; i < pending.length; i += 25) groups.push(pending.slice(i, i + 25));
      const lines = groups.map((g) => ({
        m: g.map((i) => {
          const d = items[i]!.data;
          return { ownerId: d.owner, namespace: d.namespace, key: d.key, type: d.type, value: d.value };
        }),
      }));
      const res = await bulkMutation(ctx.client, BULK_SET, lines, { timeoutMs: bulkTimeoutMs() });
      const again: number[] = [];
      res.forEach((r, li) => {
        const g = groups[li]!;
        const errs = [...(r.errors ?? []).map((e) => ({ message: e.message, field: undefined as string[] | undefined })), ...((r.data?.metafieldsSet?.userErrors as { message: string; field?: string[] }[]) ?? [])];
        if (!errs.length) {
          g.forEach((i, k) => (results[i] = { id: r.data?.metafieldsSet?.metafields?.[k]?.id ?? "" }));
          return;
        }
        const byIndex = new Map<number, string>();
        for (const e of errs) {
          const idx = Number(e.field?.[1]);
          if (Number.isInteger(idx)) byIndex.set(idx, e.message);
        }
        g.forEach((i, k) => {
          const own = byIndex.get(k);
          if (own) results[i] = { error: own };
          else if (byIndex.size) again.push(i);
          else results[i] = { error: errs.map((e) => e.message).join("; ") };
        });
      });
      pending = again;
    }
    for (const i of pending) results[i] = { error: "not written: other values in the same batch kept failing" };
    return results;
  },

  create: (ctx, _key, d) => set(ctx, d),
  async update(ctx, _target, d) {
    await set(ctx, d);
  },
};
