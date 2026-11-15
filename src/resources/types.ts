import type { AdminClient } from "../shopify/client.js";
import type { GidToRefMapper, RefToGidResolver } from "../refs.js";

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
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** Read by default. products, metafields and translations can be large, so they are opt-in. */
export const OPT_IN_KINDS: readonly ResourceKind[] = ["products", "metafields", "translations"];
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
  /** Metafield owner types to read definitions for. */
  ownerTypes?: string[];
  /** Metaobject types to read entries for. Defaults to every syncable definition type. */
  metaobjectTypes?: string[];
  /** Metafield namespaces to read values for (metafields kind). Default: all non-app namespaces. */
  namespaces?: string[];
  /** Locales to read translations for. Default: every non-primary locale of the store. */
  locales?: string[];
  /** Include variant prices and compare-at prices (products kind). Off by default: prices usually differ per store. */
  prices?: boolean;
  /**
   * Narrows which products are read, taken from include patterns that are plain handles
   * ("linen-shirt") or handle prefixes ("linen-*"). Undefined means every product.
   */
  productHandles?: { exact: string[]; prefixes: string[] };
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
}
