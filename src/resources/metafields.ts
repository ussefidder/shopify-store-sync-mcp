import { assertNoUserErrors, paginate } from "../shopify/client.js";
import type { Item, ResourceAdapter } from "./types.js";
import { reservedPrefix } from "./util.js";

/*
 * Metafield values on products and collections, keyed by OWNER/handle/namespace.key.
 * The owner is stored as a portable ref, so a value lands on the product or collection
 * with the same handle in the target. Reference values (product, metaobject, file...)
 * are remapped like everywhere else.
 */

const OWNERS = [
  { type: "PRODUCT", field: "products", page: 5 },
  { type: "COLLECTION", field: "collections", page: 5 },
] as const;

const query = (owner: string, size: number) => /* GraphQL */ `
  query MetafieldValues($after: String, $namespace: String) {
    ${owner}(first: ${size}, after: $after) {
      nodes {
        id
        handle
        metafields(first: 100, namespace: $namespace) {
          nodes { namespace key type value }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface OwnerNode {
  id: string;
  handle: string;
  metafields: { nodes: { namespace: string; key: string; type: string; value: string }[]; pageInfo: { hasNextPage: boolean } };
}

/** Namespaces that belong to apps or to Shopify's standard product taxonomy. */
function skipNamespace(ns: string): string | undefined {
  return reservedPrefix(ns) ?? (ns === "shopify" ? "Shopify standard (category) metafield" : undefined);
}

export function metafieldItems(ownerType: string, owner: OwnerNode, namespaces?: string[]) {
  const items: Item[] = [];
  const skipped: { key: string; reason: string }[] = [];
  for (const m of owner.metafields.nodes) {
    const key = `${ownerType}/${owner.handle}/${m.namespace}.${m.key}`;
    if (namespaces?.length && !namespaces.includes(m.namespace)) continue;
    const reason = skipNamespace(m.namespace);
    if (reason) {
      skipped.push({ key, reason });
      continue;
    }
    items.push({ key, id: owner.id, data: { owner: owner.id, namespace: m.namespace, key: m.key, type: m.type, value: m.value } });
  }
  if (owner.metafields.pageInfo.hasNextPage) {
    skipped.push({ key: `${ownerType}/${owner.handle}/*`, reason: "more than 100 metafields; only the first 100 were read (filter with namespaces)" });
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

export const metafields: ResourceAdapter = {
  kind: "metafields",
  description:
    "Metafield values on products and collections, keyed by OWNER/handle/namespace.key. Matched to the item with the same handle in the target. Opt-in (not in the default set).",

  async fetch(client, opts) {
    const items: Item[] = [];
    const skipped: { key: string; reason: string }[] = [];
    const namespace = opts.namespaces?.length === 1 ? opts.namespaces[0] : undefined;
    for (const owner of OWNERS) {
      const nodes = await paginate<OwnerNode>(client, query(owner.field, owner.page), { namespace }, (d) => d[owner.field]);
      for (const n of nodes) {
        const r = metafieldItems(owner.type, n, opts.namespaces);
        items.push(...r.items);
        skipped.push(...r.skipped);
      }
    }
    return { items, skipped };
  },

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
