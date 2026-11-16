import { draftView } from "./drafts.js";
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

/** The data as the read options ask for it (today: without published state when `drafts` is on). */
export function applyView(kind: ResourceKind, data: Record<string, unknown>, opts: FetchOptions): Record<string, unknown> {
  let out = opts.drafts ? draftView(kind, data) : data;
  // A folder may hold prices and stock; they are compared only when asked for, as with a store.
  if (kind === "products" && Array.isArray(out.variants) && (!opts.prices || !opts.inventory)) {
    const variants = (out.variants as Record<string, unknown>[]).map((v) => {
      const { price, compareAtPrice, inventory, ...rest } = v;
      return { ...rest, ...(opts.prices ? { price, compareAtPrice } : {}), ...(opts.inventory ? { inventory } : {}) };
    });
    out = { ...out, variants: variants.map((v) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined))) };
  }
  return out;
}

/** Called when one resource type has been read from a store. */
export type ReadProgress = (store: string, kind: ResourceKind, items: number) => void;

/** Read resources from a store and rewrite every GID inside `data` into a portable ref. */
export async function takeSnapshot(
  client: AdminClient,
  kinds: readonly ResourceKind[],
  opts: FetchOptions = {},
  onRead?: ReadProgress,
): Promise<Snapshot> {
  const mapper = new GidToRefMapper(client);
  const resources: Snapshot["resources"] = {};

  // Read every resource type at once; the requests are independent.
  const fetched = await Promise.all(
    orderKinds(kinds).map(async (kind) => {
      const res = await ADAPTERS[kind].fetch(client, opts, mapper);
      onRead?.(client.store.alias, kind, res.items.length);
      return { kind, ...res };
    }),
  );
  const gids = new Set<string>();
  for (const f of fetched) for (const item of f.items) for (const g of collectGids(item.data)) gids.add(g);
  await mapper.load(gids);
  for (const { kind, items, skipped } of fetched) {
    resources[kind] = {
      items: items.map((i) => ({ ...i, data: applyView(kind, mapper.map(i.data), opts) })),
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
