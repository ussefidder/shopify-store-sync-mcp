import type { AdminClient } from "./shopify/client.js";

/**
 * Resource IDs differ between stores, so before comparing or copying anything we
 * rewrite every Shopify GID into a portable reference that is stable across stores:
 *
 *   gid://shopify/Product/123            -> shopify://Product/<handle>
 *   gid://shopify/Collection/123         -> shopify://Collection/<handle>
 *   gid://shopify/Page/123               -> shopify://Page/<handle>
 *   gid://shopify/Blog/123               -> shopify://Blog/<handle>
 *   gid://shopify/Metaobject/123         -> shopify://Metaobject/<type>/<handle>
 *   gid://shopify/MetaobjectDefinition/1 -> shopify://MetaobjectDefinition/<type>
 *   gid://shopify/CustomerAccountPage/1  -> shopify://CustomerAccountPage/<handle>
 *   gid://shopify/ShopPolicy/1           -> shopify://ShopPolicy/<TYPE>
 *
 * Anything we can't map (files, variants, articles...) becomes shopify://unresolved/<Type>/<id>
 * and is reported as a warning instead of being silently copied.
 */

export const GID_RE = /^gid:\/\/shopify\/([A-Za-z]+)\/(\d+)$/;
export const REF_PREFIX = "shopify://";
export const UNRESOLVED_PREFIX = "shopify://unresolved/";

export function isGid(v: unknown): v is string {
  return typeof v === "string" && GID_RE.test(v);
}

export function isPortableRef(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(REF_PREFIX);
}

/**
 * Apply `fn` to every string leaf of a value. Strings holding JSON (metaobject list
 * fields, validation values) are parsed, walked and re-serialized so nested IDs are found too.
 */
export function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
      try {
        const parsed = JSON.parse(trimmed);
        return JSON.stringify(mapStrings(parsed, fn));
      } catch {
        /* not JSON, treat as plain string */
      }
    }
    return fn(value);
  }
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}

export function collectGids(value: unknown): Set<string> {
  const found = new Set<string>();
  mapStrings(value, (s) => {
    if (isGid(s)) found.add(s);
    return s;
  });
  return found;
}

export function collectRefs(value: unknown): Set<string> {
  const found = new Set<string>();
  mapStrings(value, (s) => {
    if (isPortableRef(s)) found.add(s);
    return s;
  });
  return found;
}

const NODES_QUERY = /* GraphQL */ `
  query PortableRefs($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      id
      ... on Product { handle }
      ... on Collection { handle }
      ... on Page { handle }
      ... on Blog { handle }
      ... on Metaobject { type handle }
      ... on MetaobjectDefinition { type }
      ... on ShopPolicy { policyType: type }
    }
  }
`;

// Types that \`nodes\` returns null for (verified against the live Admin API), so they are listed instead.
const LIST_LOOKUPS: Record<string, { query: string; pick: (d: any) => { id: string; key: string }[] }> = {
  CustomerAccountPage: {
    query: `query { customerAccountPages(first: 100) { nodes { id handle } } }`,
    pick: (d) => d.customerAccountPages.nodes.map((n: { id: string; handle: string }) => ({ id: n.id, key: n.handle })),
  },
  ShopPolicy: {
    query: `query { shop { shopPolicies { id type } } }`,
    pick: (d) => d.shop.shopPolicies.map((n: { id: string; type: string }) => ({ id: n.id, key: n.type })),
  },
};

type RefNode =
  | { __typename: "Product" | "Collection" | "Page" | "Blog"; id: string; handle: string }
  | { __typename: "Metaobject"; id: string; type: string; handle: string }
  | { __typename: "MetaobjectDefinition"; id: string; type: string }
  | { __typename: "ShopPolicy"; id: string; policyType: string }
  | { __typename: string; id: string };

export function nodeToRef(node: RefNode): string | undefined {
  switch (node.__typename) {
    case "Product":
    case "Collection":
    case "Page":
    case "Blog":
      return `${REF_PREFIX}${node.__typename}/${(node as { handle: string }).handle}`;
    case "Metaobject": {
      const n = node as { type: string; handle: string };
      return `${REF_PREFIX}Metaobject/${n.type}/${n.handle}`;
    }
    case "MetaobjectDefinition":
      return `${REF_PREFIX}MetaobjectDefinition/${(node as { type: string }).type}`;
    case "ShopPolicy":
      return `${REF_PREFIX}ShopPolicy/${(node as { policyType: string }).policyType}`;
    default:
      return undefined;
  }
}

function unresolved(gid: string): string {
  const m = GID_RE.exec(gid);
  return `${UNRESOLVED_PREFIX}${m?.[1] ?? "Unknown"}/${m?.[2] ?? gid}`;
}

/** Converts GIDs of one store into portable refs. */
export class GidToRefMapper {
  private readonly cache = new Map<string, string>();

  constructor(private readonly client: AdminClient) {}

  async load(gids: Iterable<string>): Promise<void> {
    const missing = [...new Set(gids)].filter((g) => !this.cache.has(g));
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100);
      const data = await this.client.request<{ nodes: (RefNode | null)[] }>(NODES_QUERY, { ids: batch });
      batch.forEach((gid, idx) => {
        const node = data.nodes[idx];
        const ref = node && nodeToRef(node);
        if (ref) this.cache.set(gid, ref);
      });
    }

    // Fallback for types the nodes query can't return.
    const left = missing.filter((g) => !this.cache.has(g));
    const types = new Set(left.map((g) => GID_RE.exec(g)?.[1]).filter((t): t is string => Boolean(t && LIST_LOOKUPS[t])));
    for (const type of types) {
      const lookup = LIST_LOOKUPS[type]!;
      const byId = new Map(lookup.pick(await this.client.request(lookup.query)).map((x) => [x.id, x.key]));
      for (const g of left) {
        const key = byId.get(g);
        if (key) this.cache.set(g, `${REF_PREFIX}${type}/${key}`);
      }
    }
    for (const g of missing) if (!this.cache.has(g)) this.cache.set(g, unresolved(g));
  }

  /** Rewrite all GIDs in a value. Call `load` first with the GIDs it contains. */
  map<T>(value: T): T {
    return mapStrings(value, (s) => (isGid(s) ? (this.cache.get(s) ?? unresolved(s)) : s)) as T;
  }
}

/** Resolves portable refs to GIDs in a (target) store. Results are cached; misses are cached as undefined. */
export class RefToGidResolver {
  private readonly cache = new Map<string, string | undefined>();

  constructor(private readonly client: AdminClient) {}

  /** Forget a cached miss, e.g. after the plan created the missing resource. */
  invalidate(ref: string): void {
    this.cache.delete(ref);
  }

  remember(ref: string, gid: string): void {
    this.cache.set(ref, gid);
  }

  async resolve(ref: string): Promise<string | undefined> {
    if (this.cache.has(ref)) return this.cache.get(ref);
    const gid = await this.lookup(ref);
    this.cache.set(ref, gid);
    return gid;
  }

  private async lookup(ref: string): Promise<string | undefined> {
    if (!ref.startsWith(REF_PREFIX) || ref.startsWith(UNRESOLVED_PREFIX)) return undefined;
    const [kind, ...rest] = ref.slice(REF_PREFIX.length).split("/");
    const c = this.client;
    switch (kind) {
      case "Product": {
        const d = await c.request(`query($h: String!) { productByIdentifier(identifier: { handle: $h }) { id } }`, { h: rest.join("/") });
        return d.productByIdentifier?.id;
      }
      case "Collection": {
        const d = await c.request(`query($h: String!) { collectionByIdentifier(identifier: { handle: $h }) { id } }`, {
          h: rest.join("/"),
        });
        return d.collectionByIdentifier?.id;
      }
      case "Page":
      case "Blog": {
        const field = kind === "Page" ? "pages" : "blogs";
        const handle = rest.join("/");
        const d = await c.request(`query($q: String!) { ${field}(first: 5, query: $q) { nodes { id handle } } }`, {
          q: `handle:'${handle.replace(/'/g, "\\'")}'`,
        });
        return (d[field].nodes as { id: string; handle: string }[]).find((n) => n.handle === handle)?.id;
      }
      case "Metaobject": {
        const [type, ...h] = rest;
        const d = await c.request(`query($t: String!, $h: String!) { metaobjectByHandle(handle: { type: $t, handle: $h }) { id } }`, {
          t: type,
          h: h.join("/"),
        });
        return d.metaobjectByHandle?.id;
      }
      case "MetaobjectDefinition": {
        const d = await c.request(`query($t: String!) { metaobjectDefinitionByType(type: $t) { id } }`, { t: rest.join("/") });
        return d.metaobjectDefinitionByType?.id;
      }
      case "CustomerAccountPage":
      case "ShopPolicy": {
        const lookup = LIST_LOOKUPS[kind]!;
        return lookup.pick(await c.request(lookup.query)).find((x) => x.key === rest.join("/"))?.id;
      }
      default:
        return undefined;
    }
  }

  /**
   * Rewrite portable refs in a value into target GIDs.
   * Returns the rewritten value and the refs that could not be resolved.
   */
  async rewrite<T>(value: T): Promise<{ value: T; missing: string[] }> {
    const refs = collectRefs(value);
    const resolved = new Map<string, string>();
    const missing: string[] = [];
    for (const ref of refs) {
      const gid = await this.resolve(ref);
      if (gid) resolved.set(ref, gid);
      else missing.push(ref);
    }
    return { value: mapStrings(value, (s) => resolved.get(s) ?? s) as T, missing };
  }
}
