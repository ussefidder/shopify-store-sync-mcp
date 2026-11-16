import { assertNoUserErrors, paginate, type AdminClient } from "../shopify/client.js";
import { REF_PREFIX, variantKey } from "../refs.js";
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
const MEDIA_FIELDS = "id mediaContentType alt";
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

/** Every product, or only the handles the include patterns name (exact handles are looked up directly, prefixes searched). */
async function readProducts(client: AdminClient, opts: FetchOptions): Promise<Node[]> {
  const h = opts.productHandles;
  if (!h) return paginate<Node>(client, QUERY, {}, (d) => d.products);
  const exact = await Promise.all(
    h.exact.map(async (handle) => (await client.request<{ productByIdentifier: Node | null }>(BY_HANDLE, { handle })).productByIdentifier),
  );
  const searched = h.prefixes.length
    ? await paginate<Node>(client, SEARCH, { query: h.prefixes.map((p) => `handle:${p}*`).join(" OR ") }, (d) => d.products)
    : [];
  const seen = new Set<string>();
  return [...exact, ...searched].filter((n): n is Node => Boolean(n) && !seen.has(n!.id) && Boolean(seen.add(n!.id)));
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

  async fetch(client, opts) {
    const nodes = await readProducts(client, opts);
    const items: Item[] = [];
    const skipped: { key: string; reason: string }[] = [];
    for (const n of nodes) {
      if (n.isGiftCard) {
        skipped.push({ key: n.handle, reason: "gift card" });
        continue;
      }
      items.push(normalizeProduct(await complete(client, n), opts));
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
