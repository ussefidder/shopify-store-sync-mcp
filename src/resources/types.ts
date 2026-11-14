import type { AdminClient } from "../shopify/client.js";
import type { RefToGidResolver } from "../refs.js";

export const RESOURCE_KINDS = [
  "metafield_definitions",
  "metaobject_definitions",
  "pages",
  "metaobjects",
  "menus",
  "redirects",
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

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
  fetch(client: AdminClient, opts: FetchOptions): Promise<FetchResult>;
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
}
