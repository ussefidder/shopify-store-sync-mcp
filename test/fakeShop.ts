import type { StoreConfig } from "../src/config.js";
import type { AdminClient } from "../src/shopify/client.js";

/**
 * In-memory stand-in for the Admin GraphQL API: just enough of each operation this
 * project uses, dispatched on the root field name. State is plain objects so tests can
 * seed and inspect it directly.
 */

let nextId = 1000;
const gid = (type: string) => `gid://shopify/${type}/${nextId++}`;

type FakeMetafield = { namespace: string; key: string; type: string; value: string };

export type FakeVariant = {
  id: string;
  options: Record<string, string>;
  metafields?: FakeMetafield[];
  sku?: string;
  price?: string;
  compareAtPrice?: string | null;
  taxable?: boolean;
  inventoryPolicy?: string;
  barcode?: string;
  /** File id of the variant's image (one of the product's media). */
  image?: string;
  tracked?: boolean;
  requiresShipping?: boolean;
  weight?: { value: number; unit: string };
  harmonizedSystemCode?: string;
  countryCodeOfOrigin?: string;
  /** Available quantity by location name. */
  stock?: Record<string, number>;
};
export interface FakeProduct {
  id: string;
  handle: string;
  metafields?: FakeMetafield[];
  title?: string;
  descriptionHtml?: string;
  vendor?: string;
  productType?: string;
  tags?: string[];
  templateSuffix?: string | null;
  isGiftCard?: boolean;
  status?: string;
  seo?: { title: string | null; description: string | null };
  /** Taxonomy category id, e.g. "aa-1-13-8". */
  category?: string;
  options?: { name: string; values: string[] }[];
  variants?: FakeVariant[];
  /** File ids, in order. */
  media?: string[];
}

export interface FakeState {
  products: FakeProduct[];
  collections: {
    id: string;
    handle: string;
    title?: string;
    descriptionHtml?: string;
    sortOrder?: string;
    templateSuffix?: string | null;
    seo?: { title: string | null; description: string | null };
    ruleSet?: { appliedDisjunctively: boolean; rules: any[] } | null;
    metafields?: FakeMetafield[];
  }[];
  /** A file with a url maps to shopify://File/<filename>; without one it stays unresolved. */
  files: { id: string; url?: string; alt?: string; kind?: "MediaImage" | "GenericFile" | "Video" | "Model3d" | "ExternalVideo" }[];
  /** How many variants and media one request returns, to exercise paging. Default: everything. */
  pageSize?: number;
  shopLocales: { locale: string; primary: boolean }[];
  /** resourceId -> locale -> key -> value */
  translations: Record<string, Record<string, Record<string, string>>>;
  /** resourceId -> translatable content keys with their digest in this store */
  translatableContent: Record<string, { key: string; digest: string }[]>;
  themes: { id: string; name: string; role: string; files: Record<string, string> }[];
  /** Built into every store. Like the live API, \`nodes\` returns null for these. */
  customerAccountPages: { id: string; handle: string }[];
  shopPolicies: { id: string; type: string; body?: string; autoManaged?: boolean }[];
  metafieldDefinitions: any[];
  metaobjectDefinitions: any[];
  metaobjects: any[];
  pages: any[];
  menus: any[];
  redirects: any[];
  shopId: string;
  shopMetafields: FakeMetafield[];
  discounts: { id: string; discount: Record<string, unknown> }[];
  locations: { id: string; name: string }[];
}

/** Files uploaded for bulk writes, by staged path (tests route uploads and downloads here). */
export const bulkFiles = new Map<string, string>();

export function emptyState(): FakeState {
  return {
    shopId: gid("Shop"),
    locations: [],
    discounts: [],
    shopMetafields: [],
    products: [],
    collections: [],
    files: [],
    customerAccountPages: [],
    shopPolicies: [],
    shopLocales: [{ locale: "en", primary: true }],
    translations: {},
    translatableContent: {},
    themes: [],
    metafieldDefinitions: [],
    metaobjectDefinitions: [],
    metaobjects: [],
    pages: [],
    menus: [],
    redirects: [],
  };
}

const conn = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
/** One page of a list; the cursor is simply the index to continue from. */
function page(nodes: unknown[], size: number | undefined, after?: string | null) {
  const start = after ? Number(after) : 0;
  const end = size ? Math.min(nodes.length, start + size) : nodes.length;
  return { nodes: nodes.slice(start, end), pageInfo: { hasNextPage: end < nodes.length, endCursor: end < nodes.length ? String(end) : null } };
}
const MEDIA_TYPE: Record<string, string> = { MediaImage: "IMAGE", Video: "VIDEO", Model3d: "MODEL_3D", ExternalVideo: "EXTERNAL_VIDEO" };
const ok = (extra: Record<string, unknown>) => ({ ...extra, userErrors: [] });

export class FakeShop implements AdminClient {
  readonly calls: { field: string; variables: Record<string, any> }[] = [];
  private readonly pendingBulk = new Map<string, Promise<void>>();
  readonly state: FakeState;

  constructor(
    readonly store: StoreConfig,
    state: Partial<FakeState> = {},
  ) {
    this.state = { ...emptyState(), ...state };
  }

  static config(alias: string, extra: Partial<StoreConfig> = {}): StoreConfig {
    return {
      alias,
      domain: `${alias}.myshopify.com`,
      accessToken: "shpat_test",
      apiVersion: "2026-10",
      allowWrites: true,
      protected: false,
      ...extra,
    };
  }

  mutations(): string[] {
    return this.calls.filter((c) => /(Create|Update|Upsert|Set|Register)$/.test(c.field)).map((c) => c.field);
  }

  async request<T = any>(query: string, v: Record<string, any> = {}): Promise<T> {
    const m = /^\s*(?:query|mutation)[^{]*\{\s*(\w+)/.exec(query);
    if (!m) throw new Error(`fake: can't parse ${query.slice(0, 60)}`);
    const field = m[1]!;
    // Aliased lookups ("p0: productByIdentifier(...)"), answered one alias at a time.
    if (/^\s*query (ProductsByHandle|ProductIds)\b/.test(query)) {
      const out: Record<string, unknown> = {};
      for (const [, alias, name] of query.matchAll(/(\w+): productByIdentifier\(identifier: \{ handle: \$(\w+) \}\)/g)) {
        this.calls.push({ field: "productByIdentifier", variables: { handle: v[name!] } });
        out[alias!] = this.handle("productByIdentifier", query, { handle: v[name!] }, this.state);
      }
      return out as T;
    }
    this.calls.push({ field, variables: v });
    const s = this.state;
    return { [field]: await this.handle(field, query, v, s) } as T;
  }

  private findNode(id: string): any {
    const s = this.state;
    const typed = (t: string, arr: any[]) => arr.filter((x) => x.id === id).map((x) => ({ __typename: t, ...x }));
    const files = s.files
      .filter((f) => f.id === id)
      .map((f) =>
        f.kind === "GenericFile"
          ? { __typename: "GenericFile", id: f.id, alt: f.alt ?? null, url: f.url ?? null }
          : { __typename: "MediaImage", id: f.id, alt: f.alt ?? null, image: f.url ? { url: f.url } : null },
      );
    const defs = s.metafieldDefinitions.filter((d) => d.id === id).map((d) => ({ ...d, __typename: "MetafieldDefinition", definitionKey: d.key }));
    const variants = s.products.flatMap((p) =>
      (p.variants ?? [])
        .filter((x) => x.id === id)
        .map((x) => ({ __typename: "ProductVariant", id: x.id, product: { handle: p.handle }, selectedOptions: Object.entries(x.options).map(([name, value]) => ({ name, value })) })),
    );
    return (
      [
        ...variants,
        ...typed("Product", s.products),
        ...typed("Collection", s.collections),
        ...files,
        ...typed("Page", s.pages),
        ...typed("Metaobject", s.metaobjects),
        ...typed("MetaobjectDefinition", s.metaobjectDefinitions),
        ...typed("Menu", s.menus),
        ...defs,
      ][0] ?? null
    );
  }

  /** A product as the products adapter queries it. */
  private productView(p: FakeProduct, after: { variants?: string | null; media?: string | null } = {}) {
    const options = p.options ?? [{ name: "Title", values: ["Default Title"] }];
    const variants = p.variants ?? [{ id: `${p.id}-v`, options: { Title: "Default Title" }, price: "0.00" }];
    return {
      id: p.id,
      handle: p.handle,
      title: p.title ?? p.handle,
      descriptionHtml: p.descriptionHtml ?? "",
      vendor: p.vendor ?? "",
      productType: p.productType ?? "",
      tags: p.tags ?? [],
      templateSuffix: p.templateSuffix ?? null,
      isGiftCard: p.isGiftCard ?? false,
      seo: p.seo ?? { title: null, description: null },
      category: p.category ? { id: `gid://shopify/TaxonomyCategory/${p.category}` } : null,
      options: options.map((o, i) => ({ name: o.name, position: i + 1, optionValues: o.values.map((name) => ({ name })) })),
      media: page(
        (p.media ?? []).map((id) => {
          const f = this.state.files.find((x) => x.id === id);
          return { mediaContentType: MEDIA_TYPE[f?.kind ?? "MediaImage"] ?? "IMAGE", id, alt: f?.alt ?? null, image: (f?.kind ?? "MediaImage") === "MediaImage" && f?.url ? { url: f.url } : null };
        }),
        this.state.pageSize,
        after.media,
      ),
      variants: page(
        variants.map((x) => ({
          id: x.id,
          sku: x.sku ?? null,
          price: x.price ?? "0.00",
          compareAtPrice: x.compareAtPrice ?? null,
          taxable: x.taxable ?? true,
          inventoryPolicy: x.inventoryPolicy ?? "DENY",
          selectedOptions: Object.entries(x.options).map(([name, value]) => ({ name, value })),
          barcode: x.barcode ?? null,
          image: x.image ? { url: this.state.files.find((f) => f.id === x.image)?.url ?? null } : null,
          inventoryItem: {
            tracked: x.tracked ?? true,
            requiresShipping: x.requiresShipping ?? true,
            harmonizedSystemCode: x.harmonizedSystemCode ?? null,
            countryCodeOfOrigin: x.countryCodeOfOrigin ?? null,
            measurement: { weight: x.weight ?? { value: 0, unit: "KILOGRAMS" } },
          },
        })),
        this.state.pageSize,
        after.variants,
      ),
    };
  }

  private handle(field: string, query: string, v: Record<string, any>, s: FakeState): unknown {
    switch (field) {
      // ---- reads
      case "nodes":
        return (v.ids as string[]).map((id) => this.findNode(id));
      case "productByIdentifier": {
        const p = s.products.find((x) => x.handle === (v.h ?? v.handle)) ?? null;
        if (p && query.includes("metafields(")) return { ...p, metafields: conn(filterNs(p.metafields, v.namespace)) };
        return p && query.includes("variants(") ? this.productView(p) : p;
      }
      case "product": {
        const p = s.products.find((x) => x.id === v.id);
        if (!p) return null;
        if (query.includes("inventoryLevels(")) {
          const levels = (x: FakeVariant) => ({
            id: `${x.id}-item`,
            inventoryLevels: conn(
              Object.entries(x.stock ?? {}).map(([name, quantity]) => {
                const loc = s.locations.find((l) => l.name === name);
                return { location: { id: loc?.id, name }, quantities: [{ quantity }] };
              }),
            ),
          });
          return {
            variants: conn(
              (p.variants ?? []).map((x) => ({ id: x.id, selectedOptions: Object.entries(x.options).map(([name, value]) => ({ name, value })), inventoryItem: levels(x) })),
            ),
          };
        }
        const view = this.productView(p, query.includes("media(") ? { media: v.after } : { variants: v.after });
        return query.includes("media(") ? { media: view.media } : { variants: view.variants };
      }
      case "collectionByIdentifier": {
        const c = s.collections.find((p) => p.handle === (v.h ?? v.handle)) ?? null;
        if (!c) return null;
        const view = { title: c.handle, descriptionHtml: "", sortOrder: "BEST_SELLING", templateSuffix: null, seo: { title: null, description: null }, ruleSet: null, ...c };
        return query.includes("metafields(") ? { ...view, metafields: conn(filterNs(c.metafields, v.namespace)) } : view;
      }
      case "menu": {
        const menu = s.menus.find((m) => m.id === v.id);
        if (!menu) return null;
        // Like the live API, every item has an id of its own.
        const withIds = (items: any[]) => {
          for (const i of items) {
            i.id ??= gid("MenuItem");
            withIds((i.items ??= []));
          }
          return items;
        };
        return { id: menu.id, items: withIds(menu.items) };
      }
      case "metaobjectByHandle":
        return s.metaobjects.find((o) => o.type === (v.t ?? v.handle?.type) && o.handle === (v.h ?? v.handle?.handle)) ?? null;
      case "customerAccountPages":
        return conn(s.customerAccountPages);
      case "shop":
        return { id: s.shopId, shopPolicies: s.shopPolicies, metafields: conn(filterNs(s.shopMetafields, v.namespace)) };
      case "discountNodes":
        return page(s.discounts, s.pageSize, v.after);
      case "productVariants": {
        const productId = /product_id:(\d+)/.exec(v.query ?? "")?.[1];
        const nodes = s.products
          .filter((p) => !productId || p.id.endsWith(`/${productId}`))
          .flatMap((p) =>
            (p.variants ?? []).map((x) => ({
              id: x.id,
              product: { handle: p.handle },
              selectedOptions: Object.entries(x.options).map(([name, value]) => ({ name, value })),
              metafields: conn(filterNs(x.metafields, v.namespace)),
            })),
          );
        return page(nodes, s.pageSize, v.after);
      }
      case "metaobjectDefinitionByType":
        return s.metaobjectDefinitions.find((d) => d.type === v.t) ?? null;
      case "metafieldDefinitions":
        return conn(
          s.metafieldDefinitions.filter(
            (d) => d.ownerType === (v.ownerType ?? v.o) && (v.n === undefined || d.namespace === v.n) && (v.k === undefined || d.key === v.k),
          ),
        );
      case "productsCount":
        return { count: s.products.length };
      case "productVariantsCount":
        return { count: s.products.reduce((n, p) => n + (p.variants?.length ?? 1), 0) };
      case "products":
        if (/query ProductIndex/.test(query)) {
          return page(
            s.products.map((p) => ({ id: p.id, handle: p.handle, title: p.title ?? p.handle, isGiftCard: p.isGiftCard ?? false })),
            s.pageSize,
            v.after,
          );
        }
        if (query.includes("variants(")) return conn(s.products.map((p) => this.productView(p)));
        return conn(s.products.map((p) => ({ ...p, metafields: conn(filterNs(p.metafields, v.namespace)) })));
      case "collections":
        return conn(
          s.collections.map((c) => ({
            title: c.handle,
            descriptionHtml: "",
            sortOrder: "BEST_SELLING",
            templateSuffix: null,
            seo: { title: null, description: null },
            ruleSet: null,
            ...c,
            metafields: conn(filterNs(c.metafields, v.namespace)),
          })),
        );
      case "shopLocales":
        return s.shopLocales;
      case "translatableResources": {
        const prefix = { PRODUCT: "Product", PAGE: "Page", COLLECTION: "Collection", METAOBJECT: "Metaobject", MENU: "Menu", SHOP_POLICY: "ShopPolicy" }[v.type as string];
        const nodes = Object.entries(s.translations)
          .filter(([id]) => id.startsWith(`gid://shopify/${prefix}/`))
          .map(([id, byLocale]) => ({
            resourceId: id,
            translations: Object.entries(byLocale[v.locale] ?? {}).map(([key, value]) => ({ key, value })),
          }));
        return conn(nodes);
      }
      case "translatableResource":
        return s.translatableContent[v.id] ? { translatableContent: s.translatableContent[v.id] } : null;
      case "files": {
        const names = [...String(v.q).matchAll(/filename:'([^']*)'/g)].map((m) => m[1]);
        return conn(
          s.files
            .filter((f) => f.url && names.some((name) => f.url!.split("?")[0]!.endsWith(`/${name}`)))
            .map((f) => ({ __typename: "MediaImage", id: f.id, alt: f.alt ?? null, image: { url: f.url } })),
        );
      }
      case "themes":
        // The only themes query in the code asks for the published (MAIN) theme.
        return conn(s.themes.filter((t) => t.role === "MAIN"));
      case "theme": {
        const t = s.themes.find((x) => x.id === v.id);
        if (!t) return null;
        if (!/files\(/.test(query)) return { id: t.id, name: t.name, role: t.role };
        const patterns = (v.filenames as string[]).map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));
        const nodes = Object.entries(t.files)
          .filter(([f]) => patterns.some((r) => r.test(f)))
          .map(([filename, content]) => ({ filename, body: { content } }));
        return { files: conn(nodes) };
      }
      case "metaobjectDefinitions":
        return conn(s.metaobjectDefinitions);
      case "metaobjects":
        return conn(s.metaobjects.filter((o) => o.type === v.type));
      case "pages": {
        if (v.q) {
          const handle = /handle:'(.*)'/.exec(v.q)?.[1];
          return conn(s.pages.filter((p) => p.handle === handle));
        }
        return conn(s.pages);
      }
      case "blogs":
        return conn([]);
      case "menus":
        return conn(s.menus);
      case "urlRedirects":
        return conn(s.redirects);

      // ---- writes
      case "metafieldDefinitionCreate": {
        const d = v.definition;
        const def = {
          id: gid("MetafieldDefinition"),
          name: d.name,
          namespace: d.namespace,
          key: d.key,
          description: d.description ?? null,
          ownerType: d.ownerType,
          pinnedPosition: d.pin ? 1 : null,
          type: { name: d.type },
          access: { storefront: d.access?.storefront ?? null, customerAccount: d.access?.customerAccount ?? null },
          capabilities: {
            adminFilterable: { enabled: d.capabilities?.adminFilterable?.enabled ?? false },
            smartCollectionCondition: { enabled: d.capabilities?.smartCollectionCondition?.enabled ?? false },
            uniqueValues: { enabled: d.capabilities?.uniqueValues?.enabled ?? false },
          },
          validations: d.validations ?? [],
        };
        s.metafieldDefinitions.push(def);
        return ok({ createdDefinition: { id: def.id } });
      }
      case "metafieldDefinitionUpdate": {
        const d = v.definition;
        const def = s.metafieldDefinitions.find((x) => x.ownerType === d.ownerType && x.namespace === d.namespace && x.key === d.key);
        if (!def) return { updatedDefinition: null, userErrors: [{ field: ["definition"], message: "not found" }] };
        Object.assign(def, { name: d.name ?? def.name, description: d.description ?? def.description, validations: d.validations ?? def.validations });
        return ok({ updatedDefinition: { id: def.id } });
      }
      case "metaobjectDefinitionCreate": {
        const d = v.definition;
        if (s.metaobjectDefinitions.some((x) => x.type === d.type)) {
          return { metaobjectDefinition: null, userErrors: [{ field: ["type"], message: "taken" }] };
        }
        const def = {
          id: gid("MetaobjectDefinition"),
          type: d.type,
          name: d.name,
          description: d.description ?? null,
          displayNameKey: d.displayNameKey ?? null,
          access: { storefront: d.access?.storefront ?? "NONE", customerAccount: d.access?.customerAccount ?? "NONE" },
          capabilities: {
            publishable: { enabled: d.capabilities?.publishable?.enabled ?? false },
            translatable: { enabled: d.capabilities?.translatable?.enabled ?? false },
            renderable: { enabled: d.capabilities?.renderable?.enabled ?? false },
            onlineStore: { enabled: d.capabilities?.onlineStore?.enabled ?? false, data: d.capabilities?.onlineStore?.data ?? null },
          },
          fieldDefinitions: (d.fieldDefinitions ?? []).map(toFieldNode),
        };
        s.metaobjectDefinitions.push(def);
        return ok({ metaobjectDefinition: { id: def.id } });
      }
      case "metaobjectDefinitionUpdate": {
        const def = s.metaobjectDefinitions.find((x) => x.id === v.id);
        for (const op of v.definition.fieldDefinitions ?? []) {
          if (op.create) def.fieldDefinitions.push(toFieldNode(op.create));
          if (op.update) Object.assign(def.fieldDefinitions.find((f: any) => f.key === op.update.key), toFieldNode({ ...op.update, type: undefined }, true));
        }
        if (v.definition.name) def.name = v.definition.name;
        return ok({ metaobjectDefinition: { id: def.id } });
      }
      case "metaobjectUpsert": {
        const { type, handle } = v.handle;
        const def = s.metaobjectDefinitions.find((d) => d.type === type);
        if (!def) return { metaobject: null, userErrors: [{ field: ["handle", "type"], message: `No definition for ${type}` }] };
        let obj = s.metaobjects.find((o) => o.type === type && o.handle === handle);
        if (!obj) {
          obj = { id: gid("Metaobject"), type, handle, fields: [], capabilities: { publishable: null } };
          s.metaobjects.push(obj);
        }
        for (const f of v.metaobject.fields ?? []) {
          const existing = obj.fields.find((x: any) => x.key === f.key);
          if (existing) existing.value = f.value;
          else obj.fields.push({ key: f.key, value: f.value });
        }
        if (v.metaobject.capabilities?.publishable) obj.capabilities.publishable = { status: v.metaobject.capabilities.publishable.status };
        return ok({ metaobject: { id: obj.id } });
      }
      case "collectionCreate": {
        const c = { id: gid("Collection"), ...v.input, ruleSet: v.input.ruleSet ?? null };
        s.collections.push(c);
        return ok({ collection: { id: c.id } });
      }
      case "collectionUpdate": {
        const c = s.collections.find((x) => x.id === v.input.id)!;
        Object.assign(c, v.input, { ruleSet: v.input.ruleSet ?? c.ruleSet ?? null });
        return ok({ collection: { id: c.id } });
      }
      case "locations":
        return conn(s.locations);
      case "inventorySetQuantities": {
        for (const q of v.input.quantities) {
          const variant = s.products.flatMap((x) => x.variants ?? []).find((x) => `${x.id}-item` === q.inventoryItemId);
          const loc = s.locations.find((l) => l.id === q.locationId);
          if (!variant || !loc) return { userErrors: [{ field: ["input"], message: "not found" }] };
          if ((variant.stock?.[loc.name] ?? null) !== q.changeFromQuantity) return { userErrors: [{ field: ["input"], message: "changeFromQuantity doesn't match" }] };
          variant.stock = { ...(variant.stock ?? {}), [loc.name]: q.quantity };
        }
        return { userErrors: [] };
      }
      case "inventoryActivate": {
        const variant = s.products.flatMap((x) => x.variants ?? []).find((x) => `${x.id}-item` === v.i);
        const loc = s.locations.find((l) => l.id === v.l);
        if (variant && loc) variant.stock = { ...(variant.stock ?? {}), [loc.name]: v.q ?? 0 };
        return { userErrors: [] };
      }
      case "stagedUploadsCreate": {
        const key = `tmp/bulk/${nextId++}/vars`;
        return { stagedTargets: [{ url: "https://upload.test/", parameters: [{ name: "key", value: key }] }], userErrors: [] };
      }
      case "bulkOperationRunQuery": {
        // Rows as Shopify writes them: each parent, then its children with __parentId.
        const q = String(v.query);
        const rows: Record<string, unknown>[] = [];
        const opts = (x: FakeVariant) => Object.entries(x.options).map(([name, value]) => ({ name, value }));
        if (/^\{\s*products/.test(q) && q.includes("variants {")) {
          for (const p of s.products) {
            const { media, variants, ...rest } = this.productView(p);
            rows.push(rest);
            for (const m of media.nodes as any[]) rows.push({ ...m, image: m.mediaContentType === "IMAGE" ? { url: s.files.find((f) => f.id === m.id)?.url } : undefined, __parentId: p.id });
            for (const x of variants.nodes as any[]) rows.push({ ...x, __parentId: p.id });
          }
        } else if (/^\{\s*products/.test(q)) {
          for (const p of s.products) {
            rows.push({ id: p.id, handle: p.handle });
            for (const m of p.metafields ?? []) rows.push({ ...m, __parentId: p.id });
          }
        } else if (q.includes("inventoryLevels")) {
          for (const x of s.products.flatMap((p) => p.variants ?? [])) {
            rows.push({ id: x.id, inventoryItem: {} });
            for (const [name, quantity] of Object.entries(x.stock ?? {})) rows.push({ id: `${x.id}-${name}`, location: { name }, quantities: [{ quantity }], __parentId: x.id });
          }
        } else {
          for (const p of s.products) {
            for (const x of p.variants ?? []) {
              rows.push({ id: x.id, selectedOptions: opts(x), product: { handle: p.handle } });
              for (const m of x.metafields ?? []) rows.push({ ...m, __parentId: x.id });
            }
          }
        }
        const id = gid("BulkOperation");
        bulkFiles.set(`https://download.test/${id}`, rows.map((r) => JSON.stringify(r)).join("\n"));
        this.pendingBulk.set(id, Promise.resolve());
        return { bulkOperation: { id, status: "CREATED" }, userErrors: [] };
      }
      case "bulkOperationRunMutation": {
        const lines = (bulkFiles.get(v.stagedUploadPath) ?? "").split("\n").filter(Boolean);
        const id = gid("BulkOperation");
        // Each line runs as its own call; results are kept as the file the operation would produce.
        this.pendingBulk.set(id, (async () => {
          const out: string[] = [];
          for (const [i, line] of lines.entries()) {
            const data = await this.request(v.mutation, JSON.parse(line));
            out.push(JSON.stringify({ data, __lineNumber: i }));
          }
          bulkFiles.set(`https://download.test/${id}`, out.join("\n"));
        })());
        return { bulkOperation: { id, status: "CREATED" }, userErrors: [] };
      }
      case "node": {
        const run = this.pendingBulk.get(v.id);
        if (!run) return null;
        return run.then(() => ({ status: "COMPLETED", errorCode: null, objectCount: "0", url: `https://download.test/${v.id}`, partialDataUrl: null }));
      }
      case "productSet": {
        const input = v.input;
        let p = v.identifier?.handle ? s.products.find((x) => x.handle === v.identifier.handle) : undefined;
        if (v.identifier?.handle && !p) return { product: null, userErrors: [{ field: ["identifier"], message: "Product does not exist" }] };
        if (!p) {
          if (s.products.some((x) => x.handle === input.handle)) return { product: null, userErrors: [{ field: ["handle"], message: "Handle has already been taken" }] };
          p = { id: gid("Product"), handle: input.handle, status: input.status ?? "ACTIVE" };
          s.products.push(p);
        }
        // Like the live API: tags, variants and files are replaced by what is sent.
        for (const k of ["title", "descriptionHtml", "vendor", "productType", "tags", "templateSuffix", "seo"] as const) {
          if (input[k] !== undefined) (p as any)[k] = input[k];
        }
        if (input.category) p.category = String(input.category).replace("gid://shopify/TaxonomyCategory/", "");
        if (input.productOptions) p.options = input.productOptions.map((o: any) => ({ name: o.name, values: o.values.map((x: any) => x.name) }));
        if (input.files) {
          // A file given by URL is created, as the live API does.
          const ids: string[] = [];
          for (const f of input.files) {
            if (f.originalSource) {
              const created = { id: gid("MediaImage"), url: f.originalSource, alt: f.alt };
              s.files.push(created);
              ids.push(created.id);
              continue;
            }
            if (!s.files.some((x) => x.id === f.id)) return { product: null, userErrors: [{ field: ["files"], message: `File ${f.id} not found` }] };
            ids.push(f.id);
          }
          p.media = ids;
        }
        if (input.variants) {
          const old = p.variants ?? [];
          p.variants = input.variants.map((iv: any) => {
            const existing = iv.id ? old.find((x) => x.id === iv.id) : undefined;
            const options = Object.fromEntries(iv.optionValues.map((o: any) => [o.optionName, o.name]));
            const fileOf = (f: any) => {
              if (!f) return undefined;
              if (f.id) return f.id;
              return s.files.find((x) => x.url === f.originalSource)?.id;
            };
            const stock = Object.fromEntries(
              (iv.inventoryQuantities ?? []).map((q: any) => [s.locations.find((l) => l.id === q.locationId)?.name ?? q.locationId, q.quantity]),
            );
            const item = iv.inventoryItem ?? {};
            return {
              id: existing?.id ?? gid("ProductVariant"),
              options,
              barcode: iv.barcode ?? existing?.barcode,
              image: fileOf(iv.file) ?? existing?.image,
              tracked: item.tracked ?? existing?.tracked,
              requiresShipping: item.requiresShipping ?? existing?.requiresShipping,
              weight: item.measurement?.weight ?? existing?.weight,
              harmonizedSystemCode: item.harmonizedSystemCode ?? existing?.harmonizedSystemCode,
              countryCodeOfOrigin: item.countryCodeOfOrigin ?? existing?.countryCodeOfOrigin,
              stock: existing ? existing.stock : Object.keys(stock).length ? stock : undefined,
              sku: iv.sku ?? existing?.sku,
              price: iv.price ?? existing?.price ?? "0.00",
              compareAtPrice: iv.compareAtPrice ?? existing?.compareAtPrice ?? null,
              taxable: iv.taxable ?? existing?.taxable,
              inventoryPolicy: iv.inventoryPolicy ?? existing?.inventoryPolicy,
            };
          });
        }
        const product = p;
        return ok({
          product: {
            id: product.id,
            handle: product.handle,
            variants: conn((product.variants ?? []).map((x) => ({ id: x.id, selectedOptions: Object.entries(x.options).map(([name, value]) => ({ name, value })) }))),
          },
        });
      }
      case "shopPolicyUpdate": {
        let p = s.shopPolicies.find((x) => x.type === v.p.type);
        if (p?.autoManaged) {
          return { shopPolicy: null, userErrors: [{ field: ["shopPolicy"], message: "Automatic management for Privacy Policy must be turned off in order to make changes." }] };
        }
        if (!p) {
          p = { id: gid("ShopPolicy"), type: v.p.type };
          s.shopPolicies.push(p);
        }
        p.body = v.p.body;
        return ok({ shopPolicy: { id: p.id } });
      }
      case "metafieldsSet": {
        const out = [];
        for (const m of v.m) {
          const shop = m.ownerId === s.shopId ? { metafields: s.shopMetafields } : undefined;
          const owner: { metafields?: FakeMetafield[] } | undefined =
            shop ?? [...s.products, ...s.collections, ...s.products.flatMap((p) => p.variants ?? [])].find((o) => o.id === m.ownerId);
          if (!owner) return { metafields: [], userErrors: [{ field: ["ownerId"], message: "Owner not found" }] };
          owner.metafields ??= [];
          const existing = owner.metafields.find((x) => x.namespace === m.namespace && x.key === m.key);
          if (existing) Object.assign(existing, { type: m.type, value: m.value });
          else owner.metafields.push({ namespace: m.namespace, key: m.key, type: m.type, value: m.value });
          out.push({ id: gid("Metafield") });
        }
        return ok({ metafields: out });
      }
      case "translationsRegister": {
        const content = s.translatableContent[v.id] ?? [];
        for (const t of v.t) {
          if (!content.some((c) => c.key === t.key && c.digest === t.translatableContentDigest)) {
            return { translations: null, userErrors: [{ field: ["translations"], message: `bad digest for ${t.key}` }] };
          }
          ((s.translations[v.id] ??= {})[t.locale] ??= {})[t.key] = t.value;
        }
        return ok({ translations: v.t.map((t: { key: string }) => ({ key: t.key })) });
      }
      case "fileCreate": {
        const f = v.files[0];
        const file = { id: gid("MediaImage"), url: f.originalSource, alt: f.alt };
        s.files.push(file);
        return ok({ files: [{ id: file.id }] });
      }
      case "pageCreate": {
        const p = { id: gid("Page"), templateSuffix: null, isPublished: true, body: "", ...v.page };
        s.pages.push(p);
        return ok({ page: { id: p.id } });
      }
      case "pageUpdate": {
        const p = s.pages.find((x) => x.id === v.id);
        Object.assign(p, v.page, { templateSuffix: v.page.templateSuffix || null });
        return ok({ page: { id: p.id } });
      }
      case "menuCreate": {
        const menu = { id: gid("Menu"), handle: v.handle, title: v.title, items: v.items.map(toMenuNode) };
        s.menus.push(menu);
        return ok({ menu: { id: menu.id } });
      }
      case "menuUpdate": {
        const menu = s.menus.find((x) => x.id === v.id);
        Object.assign(menu, { title: v.title, items: v.items.map(toMenuNode) });
        return ok({ menu: { id: menu.id } });
      }
      case "urlRedirectCreate": {
        const r = { id: gid("UrlRedirect"), path: v.r.path, target: v.r.target };
        s.redirects.push(r);
        return ok({ urlRedirect: { id: r.id } });
      }
      case "urlRedirectUpdate": {
        const r = s.redirects.find((x) => x.id === v.id);
        r.target = v.r.target;
        return ok({ urlRedirect: { id: r.id } });
      }
      default:
        throw new Error(`fake: unhandled field ${field} in ${query.slice(0, 80)}`);
    }
  }
}

function filterNs(m: FakeMetafield[] | undefined, ns?: string): FakeMetafield[] {
  return (m ?? []).filter((x) => !ns || x.namespace === ns);
}

function toFieldNode(f: any, partial = false): any {
  const node: any = {
    key: f.key,
    name: f.name ?? f.key,
    description: f.description ?? null,
    required: f.required ?? false,
    validations: f.validations ?? [],
    capabilities: { adminFilterable: { enabled: f.capabilities?.adminFilterable?.enabled ?? false } },
  };
  if (!partial || f.type) node.type = { name: f.type };
  return node;
}

function toMenuNode(i: any): any {
  return {
    id: i.id ?? gid("MenuItem"),
    title: i.title,
    type: i.type,
    url: i.url ?? (i.resourceId ? `https://example.com/${i.resourceId}` : null),
    resourceId: i.resourceId ?? null,
    tags: i.tags ?? [],
    items: (i.items ?? []).map(toMenuNode),
  };
}
