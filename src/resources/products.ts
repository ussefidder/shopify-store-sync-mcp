import { assertNoUserErrors, envNumber, paginate, type AdminClient } from "../shopify/client.js";
import { bulkQuery } from "../shopify/bulk.js";
import { eachLimited } from "../refs.js";
import { REF_PREFIX, variantKey, type GidToRefMapper } from "../refs.js";
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

const VARIANTS_PAGE = 50;
const MEDIA_PAGE = 50;
const VARIANT_FIELDS = "id sku price compareAtPrice taxable inventoryPolicy selectedOptions { name value }";
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
    products(first: 10, after: $after) {
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
  price: string;
  compareAtPrice: string | null;
  taxable?: boolean | null;
  inventoryPolicy?: string | null;
  selectedOptions: { name: string; value: string }[];
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

export function normalizeProduct(n: Node, opts: Pick<FetchOptions, "prices"> = {}): Item {
  const options = [...n.options].sort((a, b) => a.position - b.position);
  const variants = n.variants.nodes.map((v) => {
    const byName = Object.fromEntries(v.selectedOptions.map((o) => [o.name, o.value]));
    const ordered = Object.fromEntries(options.map((o) => [o.name, byName[o.name] ?? ""]));
    return compact({
      options: ordered,
      sku: v.sku || undefined,
      taxable: v.taxable ?? undefined,
      inventoryPolicy: v.inventoryPolicy || undefined,
      price: opts.prices ? v.price : undefined,
      compareAtPrice: opts.prices ? v.compareAtPrice || undefined : undefined,
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

type Variant = { options: Record<string, string>; sku?: string; taxable?: boolean; inventoryPolicy?: string; price?: string; compareAtPrice?: string };
type Image = { file: string; alt?: string };

function optionValuesInput(options: Record<string, string>) {
  return Object.entries(options).map(([optionName, name]) => ({ optionName, name }));
}

/** productSet input for the source data, merged with what the target already has so nothing is removed. */
export function productSetInput(d: Record<string, unknown>, target: Node | undefined, create: boolean) {
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
      taxable: v.taxable,
      inventoryPolicy: v.inventoryPolicy,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
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
    products(first: 10, after: $after, query: $query) {
      nodes { ${NODE_FIELDS} }
      ${PAGE_INFO}
    }
  }
`;

/** Above this many products a full read goes through a bulk operation instead of pages. */
export const bulkThreshold = () => envNumber("SYNC_BULK_THRESHOLD", 250);
const LOOKUPS_PER_REQUEST = 5;

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
  const exact = await readByHandles(client, h.exact);
  const searched = h.prefixes.length
    ? await paginate<Node>(client, SEARCH, { query: h.prefixes.map((p) => `handle:${p}*`).join(" OR ") }, (d) => d.products)
    : [];
  const seen = new Set<string>();
  return [...exact, ...searched].filter((n) => !seen.has(n.id) && Boolean(seen.add(n.id)));
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

async function set(client: AdminClient, d: Record<string, unknown>, create: boolean): Promise<string> {
  const target = create ? undefined : await readTarget(client, String(d.handle));
  const res = await client.request(
    `mutation($identifier: ProductSetIdentifiers, $input: ProductSetInput!) {
      productSet(identifier: $identifier, input: $input, synchronous: true) { product { id } userErrors { field message code } }
    }`,
    { identifier: create ? undefined : { handle: d.handle }, input: productSetInput(d, target, create) },
  );
  assertNoUserErrors(res.productSet, `productSet ${String(d.handle)}`);
  return res.productSet.product.id;
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
    for (const n of full) {
      if (n.isGiftCard) {
        skipped.push({ key: n.handle, reason: "gift card" });
        continue;
      }
      seedImages(mapper, n);
      items.push(normalizeProduct(n, opts));
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

  create: ({ client }, _key, d) => set(client, d, true),
  async update({ client }, _target, d) {
    await set(client, d, false);
  },
};
