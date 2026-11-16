import type { AdminClient } from "../shopify/client.js";
import type { FileSource, GidToRefMapper, RefToGidResolver } from "../refs.js";

/** In apply order: things that are referenced come before the things that reference them. */
export const RESOURCE_KINDS = [
  "metafield_definitions",
  "metaobject_definitions",
  "products",
  "collections",
  "pages",
  "shop_policies",
  "metaobjects",
  "menus",
  "redirects",
  "metafields",
  "translations",
  "discounts",
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** Read by default. products, metafields and translations can be large, so they are opt-in; discounts are compare-only. */
export const OPT_IN_KINDS: readonly ResourceKind[] = ["products", "metafields", "translations", "discounts"];
export const DEFAULT_KINDS: readonly ResourceKind[] = RESOURCE_KINDS.filter((k) => !OPT_IN_KINDS.includes(k));

/** A resource as fetched from a store. `data` is what gets compared and copied. */
export interface Item {
  /** Stable identity across stores, e.g. "PRODUCT.custom.material" or "faq/shipping". */
  key: string;
  /** GID in the store it was fetched from. */
  id: string;
  data: Record<string, unknown>;
}

export interface FetchOptions {
  /** Also read Shopify-reserved metafield definitions (namespace "shopify", category metafields), to compare them. They are never written. */
  includeReserved?: boolean;
  /** Metafield owner types to read definitions for (and values: PRODUCT, COLLECTION, PRODUCTVARIANT, SHOP). */
  ownerTypes?: string[];
  /** Metaobject types to read entries for. Defaults to every syncable definition type. */
  metaobjectTypes?: string[];
  /** Metafield namespaces to read values for (metafields kind). Default: all non-app namespaces. */
  namespaces?: string[];
  /** Locales to read translations for. Default: every non-primary locale of the store. */
  locales?: string[];
  /** Include variant prices and compare-at prices (products kind). Off by default: prices usually differ per store. */
  prices?: boolean;
  /** Include stock: available quantities per location, matched to the target's locations by name (products kind). */
  inventory?: boolean;
  /**
   * Leave the published state out (pages, metaobjects), so new items arrive hidden or as drafts
   * and existing ones keep the state they have in the target.
   */
  drafts?: boolean;
  /**
   * Narrows which metafield values are read, taken from include patterns shaped like
   * "PRODUCT/<handle>/...", "PRODUCTVARIANT/<product handle>/..." or "SHOP/...". Undefined means every owner.
   */
  metafieldOwners?: { PRODUCT?: string[]; COLLECTION?: string[]; PRODUCTVARIANT?: string[]; SHOP?: boolean };
  /**
   * Narrows which products are read, taken from include patterns that are plain handles
   * ("linen-shirt") or handle prefixes ("linen-*"). Undefined means every product.
   */
  productHandles?: { exact: string[]; prefixes: string[] };
  /**
   * Products known to exist (from a cheap handle listing) that are not read in full, because the
   * other store has nothing to compare them with. They are reported by handle and title only.
   */
  productStubs?: { id: string; handle: string; title: string }[];
  /**
   * Narrows the read to items whose key is one of `exact` or starts with one of `prefixes`, taken
   * from include patterns (or from the keys a plan touches). Adapters that can look items up
   * directly use it (metaobjects, collections); the others read everything and the filter runs after.
   */
  keys?: { exact: string[]; prefixes: string[] };
}

export interface FetchResult {
  items: Item[];
  /** Things that were deliberately not read (app-owned, reserved...), for the report. */
  skipped: { key: string; reason: string }[];
}

export interface WriteContext {
  client: AdminClient;
  resolver: RefToGidResolver;
}

export interface ResourceAdapter {
  kind: ResourceKind;
  description: string;
  /** `mapper` lets an adapter key items by a portable ref (translations do). GIDs in data are mapped afterwards anyway. */
  fetch(client: AdminClient, opts: FetchOptions, mapper: GidToRefMapper): Promise<FetchResult>;
  /** Create the resource in the target. `data` has already had refs rewritten to target GIDs. */
  create(ctx: WriteContext, key: string, data: Record<string, unknown>): Promise<string>;
  /** Update an existing target resource so it matches `data`. Never deletes target-only content. */
  update(ctx: WriteContext, target: Item, data: Record<string, unknown>): Promise<void>;
  /**
   * Optional: return a reason when the target can't be brought in line by an update
   * (e.g. a metafield definition whose type differs). The op is then reported as a conflict.
   */
  conflict?(source: Item, target: Item): string | undefined;
  /**
   * Items this tool compares but never writes (Shopify-reserved definitions read with
   * includeReserved). The reason is reported as a conflict in plans instead of a create or update.
   */
  readOnly?(item: Item): string | undefined;
  /** Portable ref the created resource can be found by, so later ops in the same plan can point at it. */
  refFor?(key: string): string | undefined;
  /**
   * Portable ref of the resource this item hangs off (a metafield value's product, say).
   * When it doesn't exist in the target the op can't succeed, so the plan reports a conflict.
   */
  ownerRef?(data: Record<string, unknown>): string | undefined;
  /**
   * Optional: the target's data with what an update would keep anyway (because nothing is ever
   * deleted) set aside, so an item already in line with the source compares as identical.
   */
  alignTarget?(source: Record<string, unknown>, target: Record<string, unknown>): Record<string, unknown>;
  /** Optional: the same value written the way Shopify writes it (0.40 and 0.4), applied to both sides before comparing. */
  canonical?(data: Record<string, unknown>): Record<string, unknown>;
  /**
   * Optional: short labels of what only the target has inside this item (menu links, say) and an
   * update will keep. Listed in the plan so nobody is surprised that they are still there.
   */
  targetOnly?(source: Record<string, unknown>, target: Record<string, unknown>): string[];
  /** Ops of this kind don't depend on each other, so they can be written a few at a time. */
  parallel?: boolean;
  /** Refs that creating this item also creates (a product's variants), besides refFor. */
  createsRefs?(key: string, data: Record<string, unknown>): string[];
  /**
   * Optional: write many items in one Shopify bulk operation. `data` already has its refs rewritten,
   * except file refs that don't exist in the target yet. Returns, per item, the new id or an error.
   * Throws BulkUnavailable when the store won't run a bulk write, so items are written one by one.
   */
  bulkWrite?(ctx: BulkWriteContext, items: { key: string; action: "create" | "update"; data: Record<string, unknown> }[]): Promise<{ id?: string; error?: string }[]>;
}

export interface BulkWriteContext extends WriteContext {
  /** Download URLs of source files, by ref, for files the target doesn't have yet. */
  files: Record<string, FileSource>;
  onPhase?: (message: string) => void;
  /** While Shopify writes: about how many of the items are written so far. */
  onWritten?: (items: number) => void;
  /** An item's result as soon as its part of the bulk write finishes (before bulkWrite returns). */
  onDone?: (index: number, result: { id?: string; error?: string }) => void;
}
