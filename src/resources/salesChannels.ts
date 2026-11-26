import { searchValue } from "../refs.js";
import { batchedMutation, writeRequests, type BatchSpec } from "../shopify/batch.js";
import { bulkQuery, bulkThreshold, bulkTimeoutMs, type LineResult } from "../shopify/bulk.js";
import { assertNoUserErrors, paginate, type AdminClient } from "../shopify/client.js";
import type { FetchOptions, Item, ResourceAdapter } from "./types.js";
import { PAGE_INFO } from "./util.js";

/*
 * Where products and collections are published, and each product's status (active, draft,
 * archived). One item per product ("Product/<handle>") and per collection ("Collection/<handle>"),
 * listing the sales channels it is published on, by app handle (online_store, pos, ...), and the
 * market catalogs that include it ("catalog:<title>"). A draft product is listed on the channels it
 * is assigned to (as Shopify admin shows them), though it only goes live there once active.
 *
 * Publishing only adds: a product published on a channel only in the target stays published there.
 * A sales channel is an app installed in the store, so it can't be created here; a product is still
 * published on the channels the target has, and the missing ones are reported.
 */

const PUBLICATIONS = /* GraphQL */ `
  query Publications($type: CatalogType, $after: String) {
    publications(first: 50, after: $after, catalogType: $type) {
      nodes {
        id
        catalog {
          __typename
          title
          ... on AppCatalog { apps(first: 1) { nodes { handle } } }
        }
      }
      ${PAGE_INFO}
    }
  }
`;

const PRODUCTS = /* GraphQL */ `
  query ProductPublications($after: String, $query: String) {
    products(first: 25, after: $after, query: $query) {
      nodes { id handle status apps: resourcePublicationsV2(first: 10, onlyPublished: false, catalogType: APP) { nodes { publication { id } } } catalogs: resourcePublicationsV2(first: 15, onlyPublished: false, catalogType: MARKET) { nodes { publication { id } } } }
      ${PAGE_INFO}
    }
  }
`;

const COLLECTIONS = /* GraphQL */ `
  query CollectionPublications($after: String, $query: String) {
    collections(first: 25, after: $after, query: $query) {
      nodes { id handle apps: resourcePublicationsV2(first: 10, onlyPublished: false, catalogType: APP) { nodes { publication { id } } } catalogs: resourcePublicationsV2(first: 15, onlyPublished: false, catalogType: MARKET) { nodes { publication { id } } } }
      ${PAGE_INFO}
    }
  }
`;

const COUNT = /* GraphQL */ `query PublishableCounts { productsCount(limit: null) { count } collectionsCount(limit: null) { count } }`;

/** Bulk exports of every product or collection with its publications, sales channels and market catalogs apart. */
const bulkPublications = (root: "products" | "collections", type: "APP" | "MARKET") => `{
  ${root} {
    edges {
      node {
        id
        handle
        ${root === "products" ? "status" : ""}
        resourcePublicationsV2(onlyPublished: false, catalogType: ${type}) { edges { node { publication { id } } } }
      }
    }
  }
}`;

interface PublicationNode {
  id: string;
  catalog: { __typename: string; title: string; apps?: { nodes: { handle: string | null }[] } } | null;
}

interface PublishableNode {
  id: string;
  handle: string;
  status?: string;
  /** Sales channels and market catalogs are asked for apart: without a catalog type Shopify returns sales channels only. */
  apps: { nodes: { publication: { id: string } }[] };
  catalogs: { nodes: { publication: { id: string } }[] };
}

/** How a publication is named across stores: the channel's app handle, or "catalog:<title>" for a market catalog. B2B catalogs are left out. */
function label(p: PublicationNode): string | undefined {
  const c = p.catalog;
  if (!c) return undefined;
  if (c.__typename === "AppCatalog") return c.apps?.nodes[0]?.handle ?? undefined;
  if (c.__typename === "MarketCatalog") return `catalog:${c.title}`;
  return undefined;
}

const cache = new WeakMap<AdminClient, Promise<Map<string, string>>>();
/** Publication id by label, read once per store connection. */
export function publicationsByLabel(client: AdminClient): Promise<Map<string, string>> {
  let hit = cache.get(client);
  if (!hit) {
    // Without a catalog type Shopify lists sales channels only; market catalogs are listed apart.
    hit = Promise.all(["APP", "MARKET"].map((type) => paginate<PublicationNode>(client, PUBLICATIONS, { type }, (d) => d.publications))).then(([apps, catalogs]) => {
      const nodes = [...apps!, ...catalogs!];
      const out = new Map<string, string>();
      for (const n of nodes) {
        const l = label(n);
        if (l && !out.has(l)) out.set(l, n.id);
      }
      return out;
    });
    cache.set(client, hit);
    hit.catch(() => cache.delete(client));
  }
  return hit;
}

/** Search query for the handles the keys name (exact or prefix), or undefined to read every one. Null when none of this type is wanted. */
function handleQuery(keys: FetchOptions["keys"], type: "Product" | "Collection"): string | undefined | null {
  if (!keys) return undefined;
  const prefix = `${type}/`;
  const exact = keys.exact.filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  const prefixes = keys.prefixes.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
  // A prefix shorter than "Product/" ("Pro*") could match anything of this type.
  if (keys.prefixes.some((p) => prefix.startsWith(p))) return undefined;
  if (!exact.length && !prefixes.length) return null;
  return [...exact.map((h) => `handle:${searchValue(h)}`), ...prefixes.map((p) => `handle:${p.replace(/[^a-z0-9-]/gi, "")}*`)].join(" OR ");
}

/** A whole catalog in two bulk exports (sales channels, then market catalogs), instead of 25 products a page. */
async function readBulk(client: AdminClient, root: "products" | "collections"): Promise<PublishableNode[]> {
  const byId = new Map<string, PublishableNode>();
  for (const type of ["APP", "MARKET"] as const) {
    const rows = await bulkQuery(client, bulkPublications(root, type), { timeoutMs: bulkTimeoutMs() });
    for (const r of rows) {
      if (r.__parentId) {
        const parent = byId.get(r.__parentId);
        if (parent) (type === "APP" ? parent.apps : parent.catalogs).nodes.push({ publication: { id: r.publication.id } });
        continue;
      }
      if (!byId.has(r.id)) byId.set(r.id, { id: r.id, handle: r.handle, status: r.status, apps: { nodes: [] }, catalogs: { nodes: [] } });
    }
  }
  return [...byId.values()];
}

function toItems(nodes: PublishableNode[], type: "Product" | "Collection", names: Map<string, string>): Item[] {
  return nodes.map((n) => ({
    key: `${type}/${n.handle}`,
    id: n.id,
    data: {
      resource: `shopify://${type}/${n.handle}`,
      ...(n.status ? { status: n.status } : {}),
      channels: [...new Set([...n.apps.nodes, ...n.catalogs.nodes].map((r) => names.get(r.publication.id)).filter((l): l is string => Boolean(l)))].sort(),
    },
  }));
}

export const salesChannels: ResourceAdapter = {
  kind: "sales_channels",
  description:
    "Where products and collections are published, keyed Product/<handle> and Collection/<handle>: the sales channels (by app handle, e.g. online_store, pos) and market catalogs (catalog:<title>) they are on, and each product's status (ACTIVE, DRAFT, ARCHIVED). Only adds: nothing is unpublished. Channels the target hasn't installed are reported, not created. Opt-in.",
  parallel: true,
  // Batched requests (not Shopify bulk operations): worth it from a handful of items.
  batchFrom: 5,
  ownerRef: (d) => (typeof d.resource === "string" ? d.resource : undefined),

  async fetch(client, opts) {
    const byId = await publicationsByLabel(client);
    const names = new Map([...byId].map(([l, id]) => [id, l]));
    const items: Item[] = [];
    const counts = opts.keys ? undefined : (await client.request<{ productsCount: { count: number } | null; collectionsCount: { count: number } | null }>(COUNT));
    for (const [type, query, pick] of [
      ["Product", PRODUCTS, (d: any) => d.products],
      ["Collection", COLLECTIONS, (d: any) => d.collections],
    ] as const) {
      const q = handleQuery(opts.keys, type);
      if (q === null) continue;
      const count = (type === "Product" ? counts?.productsCount : counts?.collectionsCount)?.count ?? 0;
      const nodes = count > bulkThreshold() ? await readBulk(client, type === "Product" ? "products" : "collections") : await paginate<PublishableNode>(client, query, q ? { query: q } : {}, pick);
      items.push(...toItems(nodes, type, names));
    }
    return { items, skipped: [] };
  },

  /**
   * Many items at once: a few publish calls per request, twelve requests at once, then the status
   * changes the same way. Publishing on a channel an item is already on changes nothing.
   */
  async bulkWrite(ctx, items) {
    const { client } = ctx;
    let byLabel = await publicationsByLabel(client);
    if (items.some((i) => ((i.data.channels as string[]) ?? []).some((c) => !byLabel.has(c)))) {
      cache.delete(client);
      byLabel = await publicationsByLabel(client);
    }
    const results: { id?: string; error?: string }[] = items.map((i) => ({ id: String(i.data.resource) }));
    const missing = items.map((i) => ((i.data.channels as string[]) ?? []).filter((c) => !byLabel.has(c)));
    const fail = (i: number, message: string) => {
      results[i] = { error: results[i]!.error ? `${results[i]!.error}; ${message}` : message };
    };

    const publish = items
      .map((it, i) => ({ i, id: String(it.data.resource), input: ((it.data.channels as string[]) ?? []).filter((c) => byLabel.has(c)).map((c) => ({ publicationId: byLabel.get(c)! })) }))
      .filter((l) => l.input.length);
    if (publish.length) {
      ctx.onPhase?.(`publishing ${publish.length} items, ${PUBLISH.perRequest} per request, ${writeRequests()} requests at once`);
      const res = await batchedMutation(client, PUBLISH, publish.map((l) => ({ id: l.id, input: l.input })), { signal: ctx.signal });
      res.forEach((r, k) => {
        const err = lineError(r, "publishablePublish");
        if (err) fail(publish[k]!.i, err);
      });
    }
    const status = items.map((it, i) => ({ i, id: String(it.data.resource), status: it.data.status })).filter((l) => typeof l.status === "string" && !results[l.i]!.error);
    if (status.length) {
      ctx.onPhase?.(`setting the status of ${status.length} products`);
      const res = await batchedMutation(client, STATUS, status.map((l) => ({ product: { id: l.id, status: l.status } })), { signal: ctx.signal });
      res.forEach((r, k) => {
        const err = lineError(r, "productUpdate");
        if (err) fail(status[k]!.i, err);
      });
    }
    missing.forEach((m, i) => {
      if (m.length) fail(i, `not published on ${m.join(", ")}: the target has no such sales channel or catalog (install the channel or sync the catalog first)`);
    });
    results.forEach((r, i) => !r.error && ctx.onDone?.(i, r));
    return results;
  },

  /** Channels only the target publishes on stay published, so they aren't differences. */
  alignTarget(source, target) {
    const wanted = new Set((source.channels as string[]) ?? []);
    return { ...target, channels: ((target.channels as string[]) ?? []).filter((c) => wanted.has(c)) };
  },

  async create(ctx, key, d) {
    await salesChannels.update(ctx, { key, id: String(d.resource), data: {} }, d);
    return String(d.resource);
  },

  async update({ client }, target, d) {
    const id = String(d.resource);
    let byLabel = await publicationsByLabel(client);
    const have = new Set((target.data.channels as string[]) ?? []);
    const wanted = ((d.channels as string[]) ?? []).filter((c) => !have.has(c));
    if (wanted.some((c) => !byLabel.has(c))) {
      // A catalog this apply just created isn't in the list read earlier: read it again once.
      cache.delete(client);
      byLabel = await publicationsByLabel(client);
    }
    const missing = wanted.filter((c) => !byLabel.has(c));
    const input = wanted.filter((c) => byLabel.has(c)).map((c) => ({ publicationId: byLabel.get(c)! }));
    if (input.length) {
      const res = await client.request(
        `mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`,
        { id, input },
      );
      assertNoUserErrors(res.publishablePublish, `publishablePublish ${target.key}`);
    }
    if (typeof d.status === "string" && d.status !== target.data.status) {
      const res = await client.request(
        `mutation ProductStatus($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } userErrors { field message } } }`,
        { product: { id, status: d.status } },
      );
      assertNoUserErrors(res.productUpdate, `productUpdate ${target.key}`);
    }
    if (missing.length) {
      throw new Error(
        `not published on ${missing.join(", ")}: the target has no such sales channel or catalog (install the channel or sync the catalog first)${input.length ? `; published on ${wanted.filter((c) => byLabel.has(c)).join(", ")}` : ""}`,
      );
    }
  },
};

const PUBLISH: BatchSpec = {
  vars: "$id#: ID!, $input#: [PublicationInput!]!",
  field: "publishablePublish(id: $id#, input: $input#) { userErrors { field message } }",
  root: "publishablePublish",
  perRequest: 25,
  idempotent: () => true,
};

const STATUS: BatchSpec = {
  vars: "$product#: ProductUpdateInput!",
  field: "productUpdate(product: $product#) { product { id } userErrors { field message } }",
  root: "productUpdate",
  perRequest: 25,
  idempotent: () => true,
};

function lineError(r: LineResult, root: string): string | undefined {
  const errs = [...(r.errors ?? []).map((e) => e.message), ...((r.data?.[root]?.userErrors as { message: string }[] | undefined) ?? []).map((e) => e.message)];
  return errs.length ? errs.join("; ") : undefined;
}
