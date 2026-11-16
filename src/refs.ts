import { paginate, type AdminClient } from "./shopify/client.js";

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
 *   gid://shopify/Menu/1                 -> shopify://Menu/<handle>
 *   gid://shopify/MetafieldDefinition/1  -> shopify://MetafieldDefinition/<OWNER>.<namespace>.<key>
 *   gid://shopify/MediaImage/1           -> shopify://File/<filename>   (also GenericFile, Video)
 *   gid://shopify/ProductVariant/1       -> shopify://ProductVariant/<product handle>/<option values, URL-encoded>
 *   gid://shopify/Shop/1                 -> shopify://Shop   (there is one per store)
 *
 * Files keep their source URL on the side, so a missing file can be uploaded to the target.
 * Anything we can't map (articles...) becomes shopify://unresolved/<Type>/<id>
 * and is reported as a warning instead of being silently copied.
 */

export const GID_RE = /^gid:\/\/shopify\/([A-Za-z]+)\/(\d+)$/;
export const REF_PREFIX = "shopify://";
export const UNRESOLVED_PREFIX = "shopify://unresolved/";

/** Identity of a variant across stores: its option values, in option order ("Size=M / Color=Black"). */
export function variantKey(options: Record<string, string>): string {
  return Object.entries(options)
    .map(([k, v]) => `${k}=${v}`)
    .join(" / ");
}

export const variantRef = (handle: string, selectedOptions: { name: string; value: string }[]) =>
  `${REF_PREFIX}ProductVariant/${handle}/${encodeURIComponent(variantKey(Object.fromEntries(selectedOptions.map((o) => [o.name, o.value]))))}`;

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
      ... on Menu { handle }
      ... on MetafieldDefinition { ownerType namespace definitionKey: key }
      ... on ProductVariant { product { handle } selectedOptions { name value } }
      ... on MediaImage { alt image { url } }
      ... on GenericFile { alt url }
      ... on Video { alt filename originalSource { url } }
    }
  }
`;

/** Where a file can be downloaded from, so it can be re-uploaded to another store. */
export interface FileSource {
  url: string;
  alt?: string;
  contentType: "IMAGE" | "FILE" | "VIDEO";
}

/** The file name Shopify shows in Content > Files, taken from a CDN URL. */
export function filenameFromUrl(url: string): string {
  const path = url.split("?")[0]!.split("#")[0]!;
  const last = path.slice(path.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

const ACCOUNT_PAGES_QUERY = /* GraphQL */ `
  query CustomerAccountPages($after: String) {
    customerAccountPages(first: 100, after: $after) { nodes { id handle } pageInfo { hasNextPage endCursor } }
  }
`;
const MENUS_QUERY = /* GraphQL */ `
  query MenuHandles($after: String) {
    menus(first: 100, after: $after) { nodes { id handle } pageInfo { hasNextPage endCursor } }
  }
`;

// Types that \`nodes\` returns null for (verified against the live Admin API), so they are listed instead.
const LIST_LOOKUPS: Record<string, (c: AdminClient) => Promise<{ id: string; key: string }[]>> = {
  CustomerAccountPage: async (c) =>
    (await paginate<{ id: string; handle: string }>(c, ACCOUNT_PAGES_QUERY, {}, (d) => d.customerAccountPages)).map((n) => ({ id: n.id, key: n.handle })),
  ShopPolicy: async (c) =>
    (await c.request(`query { shop { shopPolicies { id type } } }`)).shop.shopPolicies.map((n: { id: string; type: string }) => ({ id: n.id, key: n.type })),
};

/**
 * Files are copied by handing Shopify a URL to download. Only Shopify's own file hosts are
 * accepted, so an edited snapshot folder can't make a store fetch something from elsewhere.
 */
export function isShopifyFileUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return host === "cdn.shopify.com" || host.endsWith(".myshopify.com");
}

export type RefNode =
  | { __typename: "Product" | "Collection" | "Page" | "Blog"; id: string; handle: string }
  | { __typename: "Metaobject"; id: string; type: string; handle: string }
  | { __typename: "MetaobjectDefinition"; id: string; type: string }
  | { __typename: "ShopPolicy"; id: string; policyType: string }
  | { __typename: "Menu"; id: string; handle: string }
  | { __typename: "MetafieldDefinition"; id: string; ownerType: string; namespace: string; definitionKey: string }
  | { __typename: "ProductVariant"; id: string; product: { handle: string }; selectedOptions: { name: string; value: string }[] }
  | { __typename: "MediaImage"; id: string; alt: string | null; image: { url: string } | null }
  | { __typename: "GenericFile"; id: string; alt: string | null; url: string | null }
  | { __typename: "Video"; id: string; alt: string | null; filename: string; originalSource: { url: string } | null }
  | { __typename: string; id: string };

/** The file behind a file node, if it is one we can copy. */
export function nodeToFile(node: RefNode): (FileSource & { filename: string }) | undefined {
  const n = node as any;
  switch (node.__typename) {
    case "MediaImage":
      return n.image?.url ? { url: n.image.url, alt: n.alt ?? undefined, contentType: "IMAGE", filename: filenameFromUrl(n.image.url) } : undefined;
    case "GenericFile":
      return n.url ? { url: n.url, alt: n.alt ?? undefined, contentType: "FILE", filename: filenameFromUrl(n.url) } : undefined;
    case "Video":
      return n.originalSource?.url ? { url: n.originalSource.url, alt: n.alt ?? undefined, contentType: "VIDEO", filename: n.filename } : undefined;
    default:
      return undefined;
  }
}

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
    case "Menu":
      return `${REF_PREFIX}Menu/${(node as { handle: string }).handle}`;
    case "ProductVariant": {
      const n = node as { product: { handle: string }; selectedOptions: { name: string; value: string }[] };
      return variantRef(n.product.handle, n.selectedOptions);
    }
    case "MetafieldDefinition": {
      const n = node as { ownerType: string; namespace: string; definitionKey: string };
      return `${REF_PREFIX}MetafieldDefinition/${n.ownerType}.${n.namespace}.${n.definitionKey}`;
    }
    default: {
      const file = nodeToFile(node);
      return file ? `${REF_PREFIX}File/${file.filename}` : undefined;
    }
  }
}

function unresolved(gid: string): string {
  const m = GID_RE.exec(gid);
  return `${UNRESOLVED_PREFIX}${m?.[1] ?? "Unknown"}/${m?.[2] ?? gid}`;
}

const NODE_BATCHES_AT_ONCE = 4;

/** Run `fn` over `items`, at most `limit` at a time. */
export async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Converts GIDs of one store into portable refs. */
export class GidToRefMapper {
  private readonly cache = new Map<string, string>();
  /** Source URLs of every file ref seen, keyed by ref. */
  readonly files = new Map<string, FileSource>();

  constructor(private readonly client: AdminClient) {}

  async load(gids: Iterable<string>): Promise<void> {
    for (const g of gids) if (GID_RE.exec(g)?.[1] === "Shop") this.cache.set(g, `${REF_PREFIX}Shop`);
    const missing = [...new Set(gids)].filter((g) => !this.cache.has(g));
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += 100) batches.push(missing.slice(i, i + 100));
    // A few batches at a time: on a big catalog these are hundreds of requests.
    await eachLimited(batches, NODE_BATCHES_AT_ONCE, async (batch) => {
      const data = await this.client.request<{ nodes: (RefNode | null)[] }>(NODES_QUERY, { ids: batch });
      batch.forEach((gid, idx) => {
        const node = data.nodes[idx];
        if (node) this.seed(node, gid);
      });
    });

    // Fallback for types the nodes query can't return.
    const left = missing.filter((g) => !this.cache.has(g));
    const types = new Set(left.map((g) => GID_RE.exec(g)?.[1]).filter((t): t is string => Boolean(t && LIST_LOOKUPS[t])));
    for (const type of types) {
      const byId = new Map((await LIST_LOOKUPS[type]!(this.client)).map((x) => [x.id, x.key]));
      for (const g of left) {
        const key = byId.get(g);
        if (key) this.cache.set(g, `${REF_PREFIX}${type}/${key}`);
      }
    }
    for (const g of missing) if (!this.cache.has(g)) this.cache.set(g, unresolved(g));
  }

  /** Record a node read elsewhere (an adapter that already has a file's URL), so it is not looked up again. */
  seed(node: RefNode, gid = node.id): void {
    const ref = nodeToRef(node);
    if (!ref) return;
    this.cache.set(gid, ref);
    const file = nodeToFile(node);
    if (file) this.files.set(ref, { url: file.url, alt: file.alt, contentType: file.contentType });
  }

  /** Rewrite all GIDs in a value. Call `load` first with the GIDs it contains. */
  map<T>(value: T): T {
    return mapStrings(value, (s) => (isGid(s) ? (this.cache.get(s) ?? unresolved(s)) : s)) as T;
  }
}

/**
 * Resolves portable refs to GIDs in a (target) store. Results are cached; misses are cached as undefined.
 * Lookups in flight are shared, so two writes that need the same missing file upload it once.
 */
export class RefToGidResolver {
  private readonly cache = new Map<string, Promise<string | undefined>>();

  /**
   * @param uploads files that may be uploaded when missing in this store (only set when applying).
   */
  constructor(
    private readonly client: AdminClient,
    private readonly uploads?: ReadonlyMap<string, FileSource>,
  ) {}

  /** True when a missing file ref would be uploaded instead of reported as missing. */
  canUpload(ref: string): boolean {
    return Boolean(this.uploads?.has(ref));
  }

  /** Files uploaded by this resolver, for the report. */
  readonly uploaded: string[] = [];

  /** When false, a missing file is reported as missing instead of uploaded (bulk writes upload files their own way). */
  allowUploads = true;

  /**
   * Look many refs up with few requests: files by name (25 per request) and products by handle
   * (10 per request). Everything else is left to resolve(). Results land in the same cache.
   */
  async prefetch(refs: Iterable<string>): Promise<void> {
    const files: string[] = [];
    const products: string[] = [];
    for (const r of new Set(refs)) {
      if (this.cache.has(r) || !r.startsWith(REF_PREFIX) || r.startsWith(UNRESOLVED_PREFIX)) continue;
      if (r.startsWith(`${REF_PREFIX}File/`)) files.push(r);
      else if (r.startsWith(`${REF_PREFIX}Product/`)) products.push(r);
    }
    const chunks = <T>(list: T[], n: number) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

    await eachLimited(chunks(products, 10), 4, async (group) => {
      const handles = group.map((r) => r.slice(`${REF_PREFIX}Product/`.length));
      const vars = handles.map((_, i) => "$h" + i + ": String!").join(", ");
      const fields = handles.map((_, i) => "p" + i + ": productByIdentifier(identifier: { handle: $h" + i + " }) { id }").join(" ");
      const query = "query ProductIds(" + vars + ") { " + fields + " }";
      const d = await this.client.request<Record<string, { id: string } | null>>(query, Object.fromEntries(handles.map((h, i) => [`h${i}`, h])));
      group.forEach((r, i) => this.cache.set(r, Promise.resolve(d[`p${i}`]?.id)));
    });

    await eachLimited(chunks(files, 25), 4, async (group) => {
      const names = group.map((r) => r.slice(`${REF_PREFIX}File/`.length));
      const q = names.map((n) => `filename:'${n.replace(/'/g, "\\'")}'`).join(" OR ");
      const d = await this.client.request(
        `query($q: String!) { files(first: 250, query: $q) { nodes { __typename id ... on MediaImage { alt image { url } } ... on GenericFile { alt url } ... on Video { alt filename originalSource { url } } } } }`,
        { q },
      );
      const nodes = d.files.nodes as RefNode[];
      const byName = new Map<string, string>();
      for (const n of nodes) {
        const f = nodeToFile(n);
        if (f && !byName.has(f.filename)) byName.set(f.filename, n.id);
      }
      // A full page may have cut some matches off: those are left for resolve() to look up one by one.
      const complete = nodes.length < 250;
      group.forEach((r, i) => {
        const id = byName.get(names[i]!);
        if (id) this.cache.set(r, Promise.resolve(id));
        else if (complete && (!this.allowUploads || !this.uploads?.has(r))) this.cache.set(r, Promise.resolve(undefined));
      });
    });
  }

  /** Forget every cached miss whose ref starts with `prefix`, so it is looked up again. */
  async forgetMisses(prefix: string): Promise<void> {
    const entries = [...this.cache].filter(([ref]) => ref.startsWith(prefix));
    await Promise.all(
      entries.map(([ref, hit]) =>
        hit.then(
          (v) => {
            if (v === undefined && this.cache.get(ref) === hit) this.cache.delete(ref);
          },
          () => undefined,
        ),
      ),
    );
  }

  /** Forget a cached miss, e.g. after the plan created the missing resource. */
  invalidate(ref: string): void {
    this.cache.delete(ref);
  }

  remember(ref: string, gid: string): void {
    this.cache.set(ref, Promise.resolve(gid));
  }

  resolve(ref: string): Promise<string | undefined> {
    let hit = this.cache.get(ref);
    if (!hit) {
      hit = this.lookup(ref);
      this.cache.set(ref, hit);
      // A failed lookup (network, refused upload) is not remembered, so it can be tried again.
      hit.catch(() => this.cache.delete(ref));
    }
    return hit;
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
        return (await LIST_LOOKUPS[kind]!(c)).find((x) => x.key === rest.join("/"))?.id;
      }
      case "Menu": {
        const handle = rest.join("/");
        const all = await paginate<{ id: string; handle: string }>(c, MENUS_QUERY, {}, (d) => d.menus);
        return all.find((n) => n.handle === handle)?.id;
      }
      case "MetafieldDefinition": {
        const [ownerType, namespace, ...key] = rest.join("/").split(".");
        const d = await c.request(
          `query($o: MetafieldOwnerType!, $n: String!, $k: String!) { metafieldDefinitions(ownerType: $o, namespace: $n, key: $k, first: 1) { nodes { id } } }`,
          { o: ownerType, n: namespace, k: key.join(".") },
        );
        return d.metafieldDefinitions.nodes[0]?.id;
      }
      case "Shop":
        return (await c.request(`query { shop { id } }`)).shop.id;
      case "ProductVariant": {
        // Every variant of the product is looked up at once and remembered, so the next one is free.
        const [handle] = rest;
        const variants = await paginate<{ id: string; selectedOptions: { name: string; value: string }[] }>(
          c,
          `query VariantRefs($h: String!, $after: String) {
            productByIdentifier(identifier: { handle: $h }) {
              variants(first: 250, after: $after) { nodes { id selectedOptions { name value } } pageInfo { hasNextPage endCursor } }
            }
          }`,
          { h: handle },
          (d) => d.productByIdentifier?.variants ?? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        );
        let found: string | undefined;
        for (const v of variants) {
          const r = variantRef(handle!, v.selectedOptions);
          if (r === ref) found = v.id;
          else if (!this.cache.has(r)) this.remember(r, v.id);
        }
        return found;
      }
      case "File":
        return this.findOrUploadFile(ref, rest.join("/"));
      default:
        return undefined;
    }
  }

  private async findOrUploadFile(ref: string, filename: string): Promise<string | undefined> {
    const d = await this.client.request(
      `query($q: String!) { files(first: 50, query: $q) { nodes { __typename id ... on MediaImage { alt image { url } } ... on GenericFile { alt url } ... on Video { alt filename originalSource { url } } } } }`,
      { q: `filename:'${filename.replace(/'/g, "\\'")}'` },
    );
    const found = (d.files.nodes as RefNode[]).find((n) => nodeToFile(n)?.filename === filename);
    if (found) return found.id;

    const source = this.allowUploads ? this.uploads?.get(ref) : undefined;
    if (!source) return undefined;
    if (!isShopifyFileUrl(source.url)) {
      throw new Error(`file ${filename} can't be uploaded: its source URL is not on a Shopify file host (${source.url.slice(0, 80)})`);
    }
    const res = await this.client.request(
      `mutation($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id } userErrors { field message code } } }`,
      { files: [{ originalSource: source.url, contentType: source.contentType, alt: source.alt, filename, duplicateResolutionMode: "RAISE_ERROR" }] },
    );
    const errors = res.fileCreate?.userErrors ?? [];
    if (errors.length) throw new Error(`fileCreate ${filename} failed: ${errors.map((e: { message: string }) => e.message).join("; ")}`);
    const id = res.fileCreate.files[0]?.id as string | undefined;
    if (id) this.uploaded.push(filename);
    return id;
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

const FILE_CREATE = `mutation FilesCreate($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id } userErrors { field message code } } }`;
const FILE_STATUS = `query FilesStatus($ids: [ID!]!) { nodes(ids: $ids) { id ... on File { fileStatus } } }`;

/**
 * Create files in the target from their source URLs, 250 per request, and wait until Shopify has
 * processed them. Each file is created once however many products use it, and Shopify fetches them
 * all at the same time instead of one product at a time. Returns the ref → id of the files that are
 * ready; the others are left out, for the caller to send by URL as before.
 */
export async function createFiles(
  client: AdminClient,
  files: { ref: string; source: FileSource }[],
  opts: { onPhase?: (message: string) => void; wait?: (ms: number) => Promise<void>; timeoutMs?: number; pollMs?: number } = {},
): Promise<Map<string, string>> {
  const created = new Map<string, string>();
  for (let i = 0; i < files.length; i += 250) {
    const batch = files.slice(i, i + 250);
    const res = await client.request<{ fileCreate: { files: { id: string }[] | null; userErrors: { message: string }[] } }>(FILE_CREATE, {
      files: batch.map((f) => ({
        originalSource: f.source.url,
        contentType: f.source.contentType,
        alt: f.source.alt,
        filename: filenameFromUrl(f.source.url),
        duplicateResolutionMode: "APPEND_UUID",
      })),
    });
    // One bad file fails the whole batch: those files go by URL with their product, as before.
    if (res.fileCreate.userErrors?.length) {
      opts.onPhase?.(`${batch.length} files could not be created ahead (${res.fileCreate.userErrors[0]!.message}); they go with their products`);
      continue;
    }
    (res.fileCreate.files ?? []).forEach((f, k) => f?.id && created.set(batch[k]!.ref, f.id));
    opts.onPhase?.(`created ${Math.min(i + 250, files.length)} of ${files.length} files, Shopify is fetching them`);
  }

  const ready = new Map<string, string>();
  let waiting = [...created];
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
  while (waiting.length) {
    const still: [string, string][] = [];
    for (let i = 0; i < waiting.length; i += 250) {
      const batch = waiting.slice(i, i + 250);
      const d = await client.request<{ nodes: ({ id: string; fileStatus?: string } | null)[] }>(FILE_STATUS, { ids: batch.map(([, id]) => id) });
      d.nodes.forEach((n, k) => {
        const status = n?.fileStatus;
        if (status === "READY") ready.set(batch[k]![0], batch[k]![1]);
        else if (status === "UPLOADED" || status === "PROCESSING") still.push(batch[k]!);
      });
    }
    waiting = still;
    if (!waiting.length || Date.now() > deadline) break;
    opts.onPhase?.(`${ready.size} of ${created.size} files ready, waiting for ${waiting.length}`);
    await wait(opts.pollMs ?? 3000);
  }
  return ready;
}
