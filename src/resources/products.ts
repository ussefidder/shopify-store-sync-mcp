import { assertNoUserErrors, envNumber, paginate, type AdminClient } from "../shopify/client.js";
import { bulkMutation, bulkQuery, bulkThreshold, bulkTimeoutMs, type LineResult } from "../shopify/bulk.js";
import { eachLimited } from "../refs.js";
import { filenameFromUrl, REF_PREFIX, variantKey, variantRef, type FileSource, type GidToRefMapper } from "../refs.js";
import type { FetchOptions, Item, ResourceAdapter } from "./types.js";
import { compact, PAGE_INFO } from "./util.js";

/*
 * Products, keyed by handle. Opt-in (not in the default set).
 *
 * What is copied: title, description, vendor, product type, category, tags, template, SEO, options,
 * variants (matched by option values, with SKU, taxable flag and inventory policy) and images.
 * Prices only with `prices: true`.
 * Never copied: inventory, sales channel publishing, status of existing products, barcodes, weight,
 * the image assigned to a variant, videos and 3D models.
 * New products are created as drafts, so nothing appears on a storefront until someone publishes it.
 *
 * Updates go through productSet, which replaces lists. To keep the "never deletes" promise the
 * target product is re-read first, and its own variants, tags and media (images, videos, 3D models)
 * are sent back alongside the source's.
 */

// Small pages: every variant now carries its inventory item, so a page of products costs more.
const PRODUCTS_PAGE = 4;
const VARIANTS_PAGE = 25;
const MEDIA_PAGE = 25;
const INVENTORY_ITEM = "inventoryItem { tracked requiresShipping harmonizedSystemCode countryCodeOfOrigin measurement { weight { value unit } } }";
const VARIANT_FIELDS = `id sku barcode price compareAtPrice taxable inventoryPolicy selectedOptions { name value } image { url } ${INVENTORY_ITEM}`;
const MEDIA_FIELDS = "id mediaContentType alt ... on MediaImage { image { url } }";
const CATEGORY_GID = "gid://shopify/TaxonomyCategory/";

const NODE_FIELDS = /* GraphQL */ `
  id
  handle
  title
  descriptionHtml
  vendor
  productType
  tags
  templateSuffix
  isGiftCard
  seo { title description }
  category { id }
  options { name position optionValues { name } }
  media(first: ${MEDIA_PAGE}) {
    nodes { ${MEDIA_FIELDS} }
    ${PAGE_INFO}
  }
  variants(first: ${VARIANTS_PAGE}) {
    nodes { ${VARIANT_FIELDS} }
    ${PAGE_INFO}
  }
`;

const QUERY = /* GraphQL */ `
  query Products($after: String) {
    products(first: ${PRODUCTS_PAGE}, after: $after) {
      nodes { ${NODE_FIELDS} }
      ${PAGE_INFO}
    }
  }
`;

const MORE_VARIANTS = /* GraphQL */ `
  query ProductVariants($id: ID!, $after: String) {
    product(id: $id) {
      variants(first: 100, after: $after) {
        nodes { ${VARIANT_FIELDS} }
        ${PAGE_INFO}
      }
    }
  }
`;

const MORE_MEDIA = /* GraphQL */ `
  query ProductMedia($id: ID!, $after: String) {
    product(id: $id) {
      media(first: 100, after: $after) {
        nodes { ${MEDIA_FIELDS} }
        ${PAGE_INFO}
      }
    }
  }
`;

const BY_HANDLE = /* GraphQL */ `
  query ProductByHandle($handle: String!) {
    productByIdentifier(identifier: { handle: $handle }) { ${NODE_FIELDS} }
  }
`;

interface VariantNode {
  id: string;
  sku: string | null;
  barcode?: string | null;
  price: string;
  compareAtPrice: string | null;
  taxable?: boolean | null;
  inventoryPolicy?: string | null;
  selectedOptions: { name: string; value: string }[];
  image?: { url: string } | null;
  inventoryItem?: {
    tracked?: boolean | null;
    requiresShipping?: boolean | null;
    harmonizedSystemCode?: string | null;
    countryCodeOfOrigin?: string | null;
    measurement?: { weight?: { value: number; unit: string } | null } | null;
  } | null;
}

interface MediaNode {
  id: string;
  mediaContentType: string;
  alt?: string | null;
  image?: { url: string } | null;
}

type PageInfo = { hasNextPage: boolean; endCursor: string | null };

interface Node {
  id: string;
  handle: string;
  title: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  tags: string[];
  templateSuffix: string | null;
  isGiftCard: boolean;
  seo: { title: string | null; description: string | null };
  category?: { id: string } | null;
  options: { name: string; position: number; optionValues: { name: string }[] }[];
  media: { nodes: MediaNode[]; pageInfo?: PageInfo };
  variants: { nodes: VariantNode[]; pageInfo: PageInfo };
}

export { variantKey } from "../refs.js";

const bareUrl = (u: string) => u.split("?")[0]!;

/** Stock per variant id: available quantity by location name. */
export type Stock = Map<string, Record<string, number>>;

export function normalizeProduct(n: Node, opts: Pick<FetchOptions, "prices" | "inventory"> = {}, stock?: Stock): Item {
  const options = [...n.options].sort((a, b) => a.position - b.position);
  // A variant's image is one of the product's media; it is kept as that media's id, so it maps to the same file.
  const mediaByUrl = new Map(n.media.nodes.filter((m) => m.image?.url).map((m) => [bareUrl(m.image!.url), m.id]));
  const variants = n.variants.nodes.map((v) => {
    const byName = Object.fromEntries(v.selectedOptions.map((o) => [o.name, o.value]));
    const ordered = Object.fromEntries(options.map((o) => [o.name, byName[o.name] ?? ""]));
    const item = v.inventoryItem ?? {};
    const weight = item.measurement?.weight;
    const imageUrl = v.image?.url ? bareUrl(v.image.url) : undefined;
    return compact({
      options: ordered,
      sku: v.sku || undefined,
      barcode: v.barcode || undefined,
      taxable: v.taxable ?? undefined,
      inventoryPolicy: v.inventoryPolicy || undefined,
      tracked: item.tracked ?? undefined,
      requiresShipping: item.requiresShipping ?? undefined,
      weight: weight && weight.value > 0 ? { value: weight.value, unit: weight.unit } : undefined,
      harmonizedSystemCode: item.harmonizedSystemCode || undefined,
      countryCodeOfOrigin: item.countryCodeOfOrigin || undefined,
      image: imageUrl ? (mediaByUrl.get(imageUrl) ?? `${REF_PREFIX}File/${filenameFromUrl(imageUrl)}`) : undefined,
      price: opts.prices ? v.price : undefined,
      compareAtPrice: opts.prices ? v.compareAtPrice || undefined : undefined,
      inventory: opts.inventory ? (stock?.get(v.id) ?? {}) : undefined,
    });
  });
  return {
    key: n.handle,
    id: n.id,
    data: compact({
      handle: n.handle,
      title: n.title,
      descriptionHtml: n.descriptionHtml || undefined,
      vendor: n.vendor || undefined,
      productType: n.productType || undefined,
      // Shopify's product taxonomy is the same in every store, so the category id is portable as it is.
      category: n.category?.id?.startsWith(CATEGORY_GID) ? n.category.id.slice(CATEGORY_GID.length) : undefined,
      tags: n.tags.length ? [...n.tags].sort() : undefined,
      templateSuffix: n.templateSuffix || undefined,
      seo: compact({ title: n.seo?.title || undefined, description: n.seo?.description || undefined }),
      options: options.map((o) => ({ name: o.name, values: o.optionValues.map((v) => v.name) })),
      variants,
      // MediaImage GIDs become portable File refs when the snapshot is mapped.
      images: n.media.nodes
        .filter((m) => m.mediaContentType === "IMAGE" && m.id)
        .map((m) => compact({ file: m.id, alt: m.alt || undefined })),
    }),
  };
}

const DONE: PageInfo = { hasNextPage: false, endCursor: null };

/** Read the pages of variants and media that didn't fit in the first request. */
async function complete(client: AdminClient, n: Node): Promise<Node> {
  let out = n;
  if (n.variants.pageInfo.hasNextPage) {
    const rest = await paginate<VariantNode>(client, MORE_VARIANTS, { id: n.id, after: n.variants.pageInfo.endCursor }, (d) => d.product.variants);
    out = { ...out, variants: { nodes: [...n.variants.nodes, ...rest], pageInfo: DONE } };
  }
  if (n.media.pageInfo?.hasNextPage) {
    const rest = await paginate<MediaNode>(client, MORE_MEDIA, { id: n.id, after: n.media.pageInfo.endCursor }, (d) => d.product.media);
    out = { ...out, media: { nodes: [...n.media.nodes, ...rest], pageInfo: DONE } };
  }
  return out;
}

type Variant = {
  options: Record<string, string>;
  sku?: string;
  barcode?: string;
  taxable?: boolean;
  inventoryPolicy?: string;
  tracked?: boolean;
  requiresShipping?: boolean;
  weight?: { value: number; unit: string };
  harmonizedSystemCode?: string;
  countryCodeOfOrigin?: string;
  image?: string;
  price?: string;
  compareAtPrice?: string;
  inventory?: Record<string, number>;
};
type Image = { file: string; alt?: string };

function optionValuesInput(options: Record<string, string>) {
  return Object.entries(options).map(([optionName, name]) => ({ optionName, name }));
}

/** productSet input for the source data, merged with what the target already has so nothing is removed. */
/** Location ids of a store by name, to place stock in the same-named location. */
export type Locations = Map<string, string>;

const LOCATIONS = /* GraphQL */ `
  query Locations {
    locations(first: 250, includeInactive: false) { nodes { id name } }
  }
`;
const locationCache = new WeakMap<AdminClient, Promise<Locations>>();
export function locationsByName(client: AdminClient): Promise<Locations> {
  let hit = locationCache.get(client);
  if (!hit) {
    hit = client.request<{ locations: { nodes: { id: string; name: string }[] } }>(LOCATIONS).then((d) => new Map(d.locations.nodes.map((l) => [l.name, l.id])));
    locationCache.set(client, hit);
  }
  return hit;
}

function inventoryItemInput(v: Variant) {
  const out = compact({
    tracked: v.tracked,
    requiresShipping: v.requiresShipping,
    harmonizedSystemCode: v.harmonizedSystemCode,
    countryCodeOfOrigin: v.countryCodeOfOrigin,
    measurement: v.weight ? { weight: { value: v.weight.value, unit: v.weight.unit } } : undefined,
  });
  return Object.keys(out).length ? out : undefined;
}

/** Stock for a variant the target doesn't have yet, in the target's locations with the same name. */
function inventoryQuantities(v: Variant, locations?: Locations) {
  if (!v.inventory || !locations) return undefined;
  const q = Object.entries(v.inventory)
    .filter(([name]) => locations.has(name))
    .map(([name, quantity]) => ({ locationId: locations.get(name)!, name: "available", quantity }));
  return q.length ? q : undefined;
}

export function productSetInput(d: Record<string, unknown>, target: Node | undefined, create: boolean, locations?: Locations) {
  const options = (d.options as { name: string; values: string[] }[]) ?? [];
  const variants = (d.variants as Variant[]) ?? [];
  const images = (d.images as Image[]) ?? [];

  // Option values: the source's, then any the target has on its own.
  const values = new Map(options.map((o) => [o.name, [...o.values]]));
  for (const o of target?.options ?? []) {
    const list = values.get(o.name);
    if (list) for (const v of o.optionValues) if (!list.includes(v.name)) list.push(v.name);
  }

  // Variants: matched by option values. Target-only variants are kept as they are.
  const targetVariants = new Map(
    (target?.variants.nodes ?? []).map((v) => [variantKey(Object.fromEntries(v.selectedOptions.map((o) => [o.name, o.value]))), v]),
  );
  const variantInputs: Record<string, unknown>[] = variants.map((v) => {
    const existing = targetVariants.get(variantKey(v.options));
    targetVariants.delete(variantKey(v.options));
    return compact({
      id: existing?.id,
      optionValues: optionValuesInput(v.options),
      sku: v.sku,
      barcode: v.barcode,
      taxable: v.taxable,
      inventoryPolicy: v.inventoryPolicy,
      inventoryItem: inventoryItemInput(v),
      file: v.image ? { id: v.image } : undefined,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
      // Stock can only be given to a new variant here; existing ones are set afterwards.
      inventoryQuantities: existing ? undefined : inventoryQuantities(v, locations),
    });
  });
  for (const v of targetVariants.values()) {
    variantInputs.push({ id: v.id, optionValues: v.selectedOptions.map((o) => ({ optionName: o.name, name: o.value })) });
  }

  // Media: the source's images, in order, then everything the target has on its own (images, videos, 3D models).
  const fileIds = new Set(images.map((i) => i.file));
  const files: Record<string, unknown>[] = images.map((i) => compact({ id: i.file, alt: i.alt }));
  for (const m of target?.media.nodes ?? []) {
    if (m.id && !fileIds.has(m.id)) files.push({ id: m.id });
  }

  // Tags: productSet overwrites the list, so the target's own tags are sent back too.
  const tags = [...new Set([...((d.tags as string[]) ?? []), ...(target?.tags ?? [])])];

  return compact({
    handle: d.handle,
    title: d.title,
    descriptionHtml: d.descriptionHtml ?? "",
    vendor: d.vendor,
    productType: d.productType,
    category: d.category ? `${CATEGORY_GID}${String(d.category)}` : undefined,
    tags,
    templateSuffix: d.templateSuffix,
    seo: d.seo,
    status: create ? "DRAFT" : undefined,
    productOptions: options.map((o) => ({ name: o.name, values: (values.get(o.name) ?? []).map((name) => ({ name })) })),
    variants: variantInputs,
    files,
  });
}

const SEARCH = /* GraphQL */ `
  query ProductSearch($query: String!, $after: String) {
    products(first: ${PRODUCTS_PAGE}, after: $after, query: $query) {
      nodes { ${NODE_FIELDS} }
      ${PAGE_INFO}
    }
  }
`;

export { bulkThreshold };
const LOOKUPS_PER_REQUEST = PRODUCTS_PAGE;

const COUNT = /* GraphQL */ `
  query ProductCount {
    productsCount(limit: null) { count }
  }
`;

const INDEX = /* GraphQL */ `
  query ProductIndex($after: String) {
    products(first: 250, after: $after) {
      nodes { id handle title isGiftCard }
      ${PAGE_INFO}
    }
  }
`;

export type ProductStub = { id: string; handle: string; title: string; isGiftCard: boolean };

/** Every product's handle and title: about 250 per request, for deciding what to read in full. */
export function listProducts(client: AdminClient): Promise<ProductStub[]> {
  return paginate<ProductStub>(client, INDEX, {}, (d) => d.products);
}

/** The same fields as NODE_FIELDS, in the edges syntax bulk queries take. */
export const BULK_QUERY = `{
  products {
    edges { node {
      id handle title descriptionHtml vendor productType tags templateSuffix isGiftCard
      seo { title description }
      category { id }
      options { name position optionValues { name } }
      media { edges { node { ${MEDIA_FIELDS} } } }
      variants { edges { node { ${VARIANT_FIELDS} } } }
    } }
  }
}`;

/** Rebuild product nodes from bulk rows: children follow with a __parentId. */
export function nodesFromBulk(rows: Record<string, any>[]): Node[] {
  const byId = new Map<string, Node>();
  const out: Node[] = [];
  for (const r of rows) {
    if (r.__parentId) continue;
    const n = { ...r, media: { nodes: [], pageInfo: DONE }, variants: { nodes: [], pageInfo: DONE } } as unknown as Node;
    byId.set(n.id, n);
    out.push(n);
  }
  for (const r of rows) {
    const parent = r.__parentId && byId.get(r.__parentId);
    if (!parent) continue;
    const { __parentId: _, ...child } = r;
    if (String(child.id).includes("/ProductVariant/")) parent.variants.nodes.push(child as VariantNode);
    else parent.media.nodes.push(child as MediaNode);
  }
  return out;
}

async function readAllBulk(client: AdminClient): Promise<Node[]> {
  return nodesFromBulk(await bulkQuery(client, BULK_QUERY, { timeoutMs: envNumber("SYNC_BULK_TIMEOUT_MS", 30 * 60_000) }));
}

/** Every product: pages for a small catalog, one bulk operation for a large one. */
async function readAll(client: AdminClient): Promise<Node[]> {
  const { productsCount } = await client.request<{ productsCount: { count: number } | null }>(COUNT);
  if ((productsCount?.count ?? 0) > bulkThreshold()) return readAllBulk(client);
  return paginate<Node>(client, QUERY, {}, (d) => d.products);
}

/** One request that looks up `n` products by handle, as aliases p0..p<n-1> with variables $h0..$h<n-1>. */
export function byHandlesQuery(n: number): string {
  const idx = Array.from({ length: n }, (_, i) => i);
  const vars = idx.map((i) => `$h${i}: String!`).join(", ");
  const fields = idx.map((i) => `  p${i}: productByIdentifier(identifier: { handle: $h${i} }) { ${NODE_FIELDS} }`).join("\n");
  return "query ProductsByHandle(" + vars + ") {\n" + fields + "\n}";
}

/** Products by exact handle, several per request (aliases), a few requests at a time. */
async function readByHandles(client: AdminClient, handles: string[]): Promise<Node[]> {
  if (handles.length > bulkThreshold()) {
    const wanted = new Set(handles);
    return (await readAll(client)).filter((n) => wanted.has(n.handle));
  }
  const groups: string[][] = [];
  for (let i = 0; i < handles.length; i += LOOKUPS_PER_REQUEST) groups.push(handles.slice(i, i + LOOKUPS_PER_REQUEST));
  const found: Node[] = [];
  await eachLimited(groups, 4, async (group) => {
    const vars = Object.fromEntries(group.map((h, i) => [`h${i}`, h]));
    const query = byHandlesQuery(group.length);
    const data = await client.request<Record<string, Node | null>>(query, vars);
    group.forEach((_, i) => {
      const n = data[`p${i}`];
      if (n) found.push(n);
    });
  });
  // Keep the order asked for, so results don't depend on which request answered first.
  const order = new Map(handles.map((h, i) => [h, i]));
  return found.sort((a, b) => (order.get(a.handle) ?? 0) - (order.get(b.handle) ?? 0));
}

/** Every product, or only the handles the include patterns name (exact handles are looked up directly, prefixes searched). */
async function readProducts(client: AdminClient, opts: FetchOptions): Promise<Node[]> {
  const h = opts.productHandles;
  if (!h) return readAll(client);
  if (h.prefixes.length) {
    // A prefix on a big catalog is read like a full read (one bulk export), then filtered.
    const { productsCount } = await client.request<{ productsCount: { count: number } | null }>(COUNT);
    if ((productsCount?.count ?? 0) > bulkThreshold()) {
      const exactSet = new Set(h.exact);
      return (await readAllBulk(client)).filter((n) => exactSet.has(n.handle) || h.prefixes.some((p) => n.handle.startsWith(p)));
    }
  }
  const exact = await readByHandles(client, h.exact);
  const searched = h.prefixes.length
    ? await paginate<Node>(client, SEARCH, { query: h.prefixes.map((p) => `handle:${p}*`).join(" OR ") }, (d) => d.products)
    : [];
  const seen = new Set<string>();
  return [...exact, ...searched].filter((n) => !seen.has(n.id) && Boolean(seen.add(n.id)));
}

const STOCK_QUERY = /* GraphQL */ `
  query VariantStock($id: ID!, $after: String) {
    product(id: $id) {
      variants(first: 25, after: $after) {
        nodes { id inventoryItem { inventoryLevels(first: 10) { nodes { location { name } quantities(names: ["available"]) { quantity } } } } }
        ${PAGE_INFO}
      }
    }
  }
`;

const STOCK_BULK = `{
  productVariants {
    edges { node {
      id
      inventoryItem { inventoryLevels { edges { node { id location { name } quantities(names: ["available"]) { quantity } } } } }
    } }
  }
}`;

type Level = { location: { name: string }; quantities: { quantity: number }[] };

/** Available stock per variant and location name, for the products read. */
async function readStock(client: AdminClient, nodes: Node[]): Promise<Stock> {
  const stock: Stock = new Map();
  const add = (variantId: string, l: Level) => {
    const q = l.quantities[0]?.quantity;
    if (q === undefined) return;
    stock.set(variantId, { ...(stock.get(variantId) ?? {}), [l.location.name]: q });
  };
  if (nodes.length > bulkThreshold()) {
    const wanted = new Set(nodes.flatMap((n) => n.variants.nodes.map((v) => v.id)));
    for (const r of await bulkQuery(client, STOCK_BULK, { timeoutMs: bulkTimeoutMs() })) {
      if (r.__parentId && wanted.has(r.__parentId)) add(r.__parentId, r as unknown as Level);
    }
    return stock;
  }
  await eachLimited(nodes, 4, async (n) => {
    const variants = await paginate<{ id: string; inventoryItem: { inventoryLevels: { nodes: Level[] } } }>(client, STOCK_QUERY, { id: n.id }, (d) => d.product.variants);
    for (const v of variants) for (const l of v.inventoryItem.inventoryLevels.nodes) add(v.id, l);
  });
  return stock;
}

/** Product images already carry their URL, so the ref mapper doesn't look each one up again. */
function seedImages(mapper: GidToRefMapper | undefined, n: Node) {
  for (const m of n.media.nodes) {
    if (m.mediaContentType === "IMAGE" && m.image?.url) mapper?.seed({ __typename: "MediaImage", id: m.id, alt: m.alt ?? null, image: m.image });
  }
}

async function readTarget(client: AdminClient, handle: string): Promise<Node | undefined> {
  const res = await client.request<{ productByIdentifier: Node | null }>(BY_HANDLE, { handle });
  return res.productByIdentifier ? complete(client, res.productByIdentifier) : undefined;
}

const hasStock = (d: Record<string, unknown>) => ((d.variants as Variant[]) ?? []).some((v) => v.inventory && Object.keys(v.inventory).length);

const STOCK_NOW = /* GraphQL */ `
  query StockNow($id: ID!, $after: String) {
    product(id: $id) {
      variants(first: 25, after: $after) {
        nodes { selectedOptions { name value } inventoryItem { id inventoryLevels(first: 10) { nodes { location { id } quantities(names: ["available"]) { quantity } } } } }
        ${PAGE_INFO}
      }
    }
  }
`;

/**
 * Stock of variants that already existed: set to the source's quantity in each same-named location,
 * compared against what the target has right now so a sale in between isn't overwritten.
 */
async function setExistingStock(client: AdminClient, productId: string, d: Record<string, unknown>, locations: Locations, existing: Set<string>) {
  type V = { selectedOptions: { name: string; value: string }[]; inventoryItem: { id: string; inventoryLevels: { nodes: { location: { id: string }; quantities: { quantity: number }[] }[] } } };
  const now = await paginate<V>(client, STOCK_NOW, { id: productId }, (x) => x.product.variants);
  const byKey = new Map(now.map((v) => [variantKey(Object.fromEntries(v.selectedOptions.map((o) => [o.name, o.value]))), v]));
  const quantities: Record<string, unknown>[] = [];
  for (const v of (d.variants as Variant[]) ?? []) {
    const key = variantKey(v.options);
    const t = byKey.get(key);
    if (!t || !existing.has(key) || !v.inventory) continue;
    for (const [name, quantity] of Object.entries(v.inventory)) {
      const locationId = locations.get(name);
      if (!locationId) continue;
      const level = t.inventoryItem.inventoryLevels.nodes.find((l) => l.location.id === locationId);
      const current = level?.quantities[0]?.quantity;
      if (!level) {
        const r = await client.request(
          `mutation($i: ID!, $l: ID!, $q: Int) { inventoryActivate(inventoryItemId: $i, locationId: $l, available: $q) { userErrors { field message } } }`,
          { i: t.inventoryItem.id, l: locationId, q: quantity },
        );
        assertNoUserErrors(r.inventoryActivate, `inventoryActivate ${String(d.handle)}`);
      } else if (current !== quantity) {
        quantities.push({ inventoryItemId: t.inventoryItem.id, locationId, quantity, changeFromQuantity: current ?? null });
      }
    }
  }
  if (!quantities.length) return;
  const r = await client.request(
    `mutation($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { field message code } } }`,
    { input: { name: "available", reason: "correction", quantities } },
  );
  assertNoUserErrors(r.inventorySetQuantities, `inventorySetQuantities ${String(d.handle)}`);
}

async function set(client: AdminClient, d: Record<string, unknown>, create: boolean): Promise<string> {
  const target = create ? undefined : await readTarget(client, String(d.handle));
  const locations = hasStock(d) ? await locationsByName(client) : undefined;
  const res = await client.request(
    `mutation($identifier: ProductSetIdentifiers, $input: ProductSetInput!) {
      productSet(identifier: $identifier, input: $input, synchronous: true) { product { id } userErrors { field message code } }
    }`,
    { identifier: create ? undefined : { handle: d.handle }, input: productSetInput(d, target, create, locations) },
  );
  assertNoUserErrors(res.productSet, `productSet ${String(d.handle)}`);
  const id = res.productSet.product.id as string;
  if (target && locations) {
    const existing = new Set(target.variants.nodes.map((v) => variantKey(Object.fromEntries(v.selectedOptions.map((o) => [o.name, o.value])))));
    await setExistingStock(client, id, d, locations, existing);
  }
  return id;
}

const BULK_SET = /* GraphQL */ `
  mutation BulkProductSet($input: ProductSetInput!) {
    productSet(input: $input, synchronous: true) {
      product { id handle variants(first: 250) { nodes { id selectedOptions { name value } } } }
      userErrors { field message code }
    }
  }
`;

/** File inputs that still hold a portable ref (a file the target doesn't have) get the source's URL instead. */
function withSources(input: Record<string, any>, files: Record<string, FileSource>): Record<string, any> {
  const fix = (f: { id?: string; alt?: string } | undefined) => {
    if (!f?.id || !f.id.startsWith(REF_PREFIX)) return f;
    const src = files[f.id];
    return src ? compact({ originalSource: src.url, contentType: src.contentType, alt: f.alt ?? src.alt }) : undefined;
  };
  return {
    ...input,
    files: ((input.files as { id?: string; alt?: string }[]) ?? []).map(fix).filter(Boolean),
    variants: ((input.variants as Record<string, any>[]) ?? []).map((v) => compact({ ...v, file: fix(v.file) })),
  };
}

/** True when `list` begins with every item of `prefix`, in order. */
function startsWith(list: unknown[], prefix: unknown[]): boolean {
  return prefix.length <= list.length && prefix.every((p, i) => JSON.stringify(p) === JSON.stringify(list[i]));
}

/**
 * The target product as the source would see it: variants, images, tags, option values and a category
 * that only the target has are kept by every update, so they don't count as differences.
 */
export function alignProduct(source: Record<string, unknown>, target: Record<string, unknown>): Record<string, unknown> {
  const out = { ...target };
  const sTags = new Set((source.tags as string[]) ?? []);
  const tags = ((target.tags as string[]) ?? []).filter((t) => sTags.has(t));
  if (tags.length) out.tags = tags;
  else delete out.tags;
  if (source.category === undefined) delete out.category;

  const sImages = (source.images as unknown[]) ?? [];
  const tImages = (target.images as unknown[]) ?? [];
  if (startsWith(tImages, sImages) && Array.isArray(target.images)) out.images = tImages.slice(0, sImages.length);

  const sOptions = (source.options as { name: string; values: string[] }[]) ?? [];
  const tOptions = (target.options as { name: string; values: string[] }[]) ?? [];
  out.options = tOptions.map((t) => {
    const s = sOptions.find((o) => o.name === t.name);
    return s && startsWith(t.values, s.values) ? { ...t, values: t.values.slice(0, s.values.length) } : t;
  });

  const sVariants = (source.variants as Variant[]) ?? [];
  const tVariants = (target.variants as Variant[]) ?? [];
  const sKeys = new Set(sVariants.map((v) => variantKey(v.options)));
  const kept = tVariants.filter((v) => sKeys.has(variantKey(v.options)));
  const order = new Map(sVariants.map((v, i) => [variantKey(v.options), i]));
  out.variants = kept.sort((a, b) => order.get(variantKey(a.options))! - order.get(variantKey(b.options))!);
  return out;
}

export const products: ResourceAdapter = {
  kind: "products",
  description:
    "Products, keyed by handle: title, description, vendor, type, category, tags, template, SEO, options, variants (matched by option values, with SKU, taxable flag and inventory policy) and images. Prices only with prices: true; inventory and sales channels are never copied. Tags, variants and media that only the target has are kept. New products are created as drafts. Opt-in (not in the default set).",

  async fetch(client, opts, mapper) {
    const nodes = await readProducts(client, opts);
    const items: Item[] = [];
    const skipped: { key: string; reason: string }[] = [];
    const full = await Promise.all(nodes.map((n) => (n.isGiftCard ? Promise.resolve(n) : complete(client, n))));
    const stock = opts.inventory ? await readStock(client, full.filter((n) => !n.isGiftCard)) : undefined;
    for (const n of full) {
      if (n.isGiftCard) {
        skipped.push({ key: n.handle, reason: "gift card" });
        continue;
      }
      seedImages(mapper, n);
      items.push(normalizeProduct(n, opts, stock));
    }
    // Known by handle only: present in this store, nothing in the other store to compare with.
    const read = new Set(nodes.map((n) => n.handle));
    for (const s of opts.productStubs ?? []) {
      if (!read.has(s.handle)) items.push({ key: s.handle, id: s.id, data: { handle: s.handle, title: s.title } });
    }
    return { items, skipped };
  },

  conflict(source, target) {
    const names = (d: Record<string, unknown>) => ((d.options as { name: string }[]) ?? []).map((o) => o.name).join(", ");
    if (names(source.data) !== names(target.data)) {
      return `options differ (${names(target.data) || "none"} in target, ${names(source.data) || "none"} in source); rename them in the target first`;
    }
    return undefined;
  },

  refFor(key) {
    return `${REF_PREFIX}Product/${key}`;
  },

  alignTarget(source, target) {
    return alignProduct(source, target);
  },

  parallel: true,

  createsRefs(key, d) {
    return ((d.variants as Variant[]) ?? []).map((v) => variantRef(key, Object.entries(v.options).map(([name, value]) => ({ name, value }))));
  },

  // New products only: one productSet per line, images taken straight from the source's URLs.
  async bulkWrite(ctx, items) {
    const locations = items.some((i) => hasStock(i.data)) ? await locationsByName(ctx.client) : undefined;
    const lines = items.map((i) => ({ input: withSources(productSetInput(i.data, undefined, true, locations), ctx.files) }));
    const toResult = (r: LineResult): { id?: string; error?: string } => {
      const ps = r.data?.productSet;
      const errors = [...(r.errors ?? []), ...(ps?.userErrors ?? [])].map((e: { message: string }) => e.message);
      if (errors.length || !ps?.product?.id) return { error: errors.join("; ") || "no product returned" };
      for (const v of ps.product.variants?.nodes ?? []) ctx.resolver.remember(variantRef(ps.product.handle, v.selectedOptions), v.id);
      return { id: ps.product.id as string };
    };
    const done = new Map<number, { id?: string; error?: string }>();
    const results = await bulkMutation(ctx.client, BULK_SET, lines, {
      timeoutMs: bulkTimeoutMs(),
      onProgress: ctx.onWritten,
      onPart: (part, parts, start, rows) => {
        rows.forEach((r, k) => {
          const res = toResult(r);
          done.set(start + k, res);
          ctx.onDone?.(start + k, res);
        });
        const failed = rows.filter((_, k) => done.get(start + k)?.error).length;
        ctx.onPhase?.(`products: part ${part} of ${parts} finished, ${rows.length - failed} written${failed ? `, ${failed} failed` : ""}`);
      },
    });
    return results.map((r, i) => done.get(i) ?? toResult(r));
  },

  create: ({ client }, _key, d) => set(client, d, true),
  async update({ client }, _target, d) {
    await set(client, d, false);
  },
};
