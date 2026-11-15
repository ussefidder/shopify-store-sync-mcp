import { ADAPTERS, orderKinds, type FetchOptions, type Item, type ResourceKind } from "./resources/index.js";
import { collectGids, GidToRefMapper, type FileSource } from "./refs.js";
import type { AdminClient } from "./shopify/client.js";

export interface ResourceSnapshot {
  items: Item[];
  skipped: { key: string; reason: string }[];
}

export interface Snapshot {
  store: string;
  domain: string;
  takenAt: string;
  resources: Partial<Record<ResourceKind, ResourceSnapshot>>;
  /** Download URLs of the files referenced, keyed by portable ref, so they can be uploaded elsewhere. */
  files: Record<string, FileSource>;
}

/** Read resources from a store and rewrite every GID inside `data` into a portable ref. */
export async function takeSnapshot(client: AdminClient, kinds: readonly ResourceKind[], opts: FetchOptions = {}): Promise<Snapshot> {
  const mapper = new GidToRefMapper(client);
  const resources: Snapshot["resources"] = {};

  // Read every resource type at once; the requests are independent.
  const fetched = await Promise.all(orderKinds(kinds).map(async (kind) => ({ kind, ...(await ADAPTERS[kind].fetch(client, opts, mapper)) })));
  const gids = new Set<string>();
  for (const f of fetched) for (const item of f.items) for (const g of collectGids(item.data)) gids.add(g);
  await mapper.load(gids);
  for (const { kind, items, skipped } of fetched) {
    resources[kind] = {
      items: items.map((i) => ({ ...i, data: mapper.map(i.data) })),
      skipped,
    };
  }

  return {
    store: client.store.alias,
    domain: client.store.domain,
    takenAt: new Date().toISOString(),
    resources,
    files: Object.fromEntries(mapper.files),
  };
}
