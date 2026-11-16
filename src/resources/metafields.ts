import { assertNoUserErrors, paginate, type AdminClient } from "../shopify/client.js";
import type { FetchOptions, Item, ResourceAdapter } from "./types.js";
import { variantKey } from "../refs.js";
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

async function set({ client }: Parameters<ResourceAdapter["create"]>[0], d: Record<string, unknown>): Promise<string> {
  const res = await client.request(
    `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { id } userErrors { field message code } } }`,
    { m: [{ ownerId: d.owner, namespace: d.namespace, key: d.key, type: d.type, value: d.value }] },
  );
  assertNoUserErrors(res.metafieldsSet, `metafieldsSet ${String(d.namespace)}.${String(d.key)}`);
  return res.metafieldsSet.metafields[0]?.id ?? "";
}

async function readOwners(
  client: AdminClient,
  owner: (typeof OWNERS)[number],
  namespace: string | undefined,
  named: FetchOptions["metafieldOwners"],
): Promise<OwnerNode[]> {
  if (!named) return paginate<OwnerNode>(client, query(owner.field, owner.page), { namespace }, (d) => d[owner.field]);
  const handles = named[owner.type] ?? [];
  const found = await Promise.all(
    handles.map(async (handle) => (await client.request<Record<string, OwnerNode | null>>(byHandle(owner.byHandle), { handle, namespace }))[owner.byHandle]),
  );
  return found.filter((n): n is OwnerNode => Boolean(n));
}

/** Variants with their metafields: every variant, or the variants of the named products. */
async function readVariants(client: AdminClient, namespace: string | undefined, handles: string[] | undefined): Promise<VariantNode[]> {
  const pick = (d: any) => d.productVariants;
  if (!handles) return paginate<VariantNode>(client, VARIANTS_QUERY, { namespace }, pick);
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

  async fetch(client, opts) {
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
    OWNERS.forEach((owner, i) => {
      for (const n of lists[i]!) add(metafieldItems(owner.type, n, opts.namespaces));
    });
    for (const v of variants) {
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

  create: (ctx, _key, d) => set(ctx, d),
  async update(ctx, _target, d) {
    await set(ctx, d);
  },
};
