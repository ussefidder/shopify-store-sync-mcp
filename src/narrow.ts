import type { FetchOptions, ResourceKind } from "./resources/types.js";

/*
 * Reading less: turning include patterns (or the keys a plan touches) into read options, so a
 * targeted comparison reads only what it compares instead of whole resource types.
 * Every narrowing here reads a superset of the matching items; the include filter still runs after.
 */

export type KeySet = NonNullable<FetchOptions["keys"]>;

/** Exact keys and key prefixes, when every pattern is a literal or ends with a single "*". */
export function keySet(patterns?: string[]): KeySet | undefined {
  if (!patterns?.length) return undefined;
  const exact: string[] = [];
  const prefixes: string[] = [];
  for (const p of patterns) {
    const star = p.indexOf("*");
    if (star === -1) exact.push(p);
    else if (star === p.length - 1 && star > 0) prefixes.push(p.slice(0, -1));
    else return undefined;
  }
  return { exact, prefixes };
}

/** "PRODUCT.*", "COLLECTION.custom.*": metafield definitions of those owner types only. */
export function ownerTypesOf(patterns?: string[]): FetchOptions["ownerTypes"] {
  if (!patterns?.length) return undefined;
  const types: string[] = [];
  for (const p of patterns) {
    const m = /^([A-Z][A-Z_]*)\./.exec(p);
    if (!m) return undefined;
    if (!types.includes(m[1]!)) types.push(m[1]!);
  }
  return types;
}

/** "PRODUCT/linen-shirt/*", "PRODUCTVARIANT/linen-shirt/*", "SHOP/*": metafield values of those owners only. */
export function metafieldOwnersOf(patterns?: string[]): FetchOptions["metafieldOwners"] {
  if (!patterns?.length) return undefined;
  const owners: { PRODUCT: string[]; COLLECTION: string[]; PRODUCTVARIANT: string[]; SHOP: boolean } = { PRODUCT: [], COLLECTION: [], PRODUCTVARIANT: [], SHOP: false };
  for (const p of patterns) {
    if (p.startsWith("SHOP/")) {
      owners.SHOP = true;
      continue;
    }
    const m = /^(PRODUCT|COLLECTION|PRODUCTVARIANT)\/([a-z0-9][a-z0-9-]*)\/.+$/.exec(p);
    if (!m) return undefined;
    const list = owners[m[1] as "PRODUCT" | "COLLECTION" | "PRODUCTVARIANT"];
    if (!list.includes(m[2]!)) list.push(m[2]!);
  }
  return owners;
}

/** Plain handles ("linen-shirt") and handle prefixes ("linen-*"): those products only. */
export function productHandlesOf(patterns?: string[]): FetchOptions["productHandles"] {
  if (!patterns?.length) return undefined;
  const exact: string[] = [];
  const prefixes: string[] = [];
  for (const p of patterns) {
    const m = /^([a-z0-9][a-z0-9-]*)(\*?)$/.exec(p);
    if (!m) return undefined;
    (m[2] ? prefixes : exact).push(m[1]!);
  }
  return { exact, prefixes };
}

/** Read options from include patterns (or exact keys). */
export function narrowed(patterns?: string[]): Pick<FetchOptions, "keys" | "ownerTypes" | "metafieldOwners" | "productHandles"> {
  return {
    keys: keySet(patterns),
    ownerTypes: ownerTypesOf(patterns),
    metafieldOwners: metafieldOwnersOf(patterns),
    productHandles: productHandlesOf(patterns),
  };
}

/**
 * Read options for re-reading exactly the items a plan touches in one resource type (the check
 * before writing, and the refresh before the second pass), on top of the options the plan used.
 */
export function forKeys(base: FetchOptions | undefined, kind: ResourceKind, keys: string[]): FetchOptions {
  const n = narrowed(keys);
  const opts: FetchOptions = { ...base, keys: n.keys };
  if (kind === "products" && n.productHandles) opts.productHandles = n.productHandles;
  if (kind === "metafields" && n.metafieldOwners) opts.metafieldOwners = n.metafieldOwners;
  if (kind === "metafield_definitions" && n.ownerTypes) {
    opts.ownerTypes = base?.ownerTypes ? base.ownerTypes.filter((t) => n.ownerTypes!.includes(t)) : n.ownerTypes;
  }
  return opts;
}
