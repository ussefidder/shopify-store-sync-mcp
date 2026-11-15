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

export interface FakeState {
  products: { id: string; handle: string; metafields?: FakeMetafield[] }[];
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
  files: { id: string; url?: string; alt?: string; kind?: "MediaImage" | "GenericFile" }[];
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
}

export function emptyState(): FakeState {
  return {
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
const ok = (extra: Record<string, unknown>) => ({ ...extra, userErrors: [] });

export class FakeShop implements AdminClient {
  readonly calls: { field: string; variables: Record<string, any> }[] = [];
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
    this.calls.push({ field, variables: v });
    const s = this.state;
    return { [field]: this.handle(field, query, v, s) } as T;
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
    return (
      [
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

  private handle(field: string, query: string, v: Record<string, any>, s: FakeState): unknown {
    switch (field) {
      // ---- reads
      case "nodes":
        return (v.ids as string[]).map((id) => this.findNode(id));
      case "productByIdentifier":
        return s.products.find((p) => p.handle === v.h) ?? null;
      case "collectionByIdentifier":
        return s.collections.find((p) => p.handle === v.h) ?? null;
      case "metaobjectByHandle":
        return s.metaobjects.find((o) => o.type === v.t && o.handle === v.h) ?? null;
      case "customerAccountPages":
        return conn(s.customerAccountPages);
      case "shop":
        return { shopPolicies: s.shopPolicies };
      case "metaobjectDefinitionByType":
        return s.metaobjectDefinitions.find((d) => d.type === v.t) ?? null;
      case "metafieldDefinitions":
        return conn(
          s.metafieldDefinitions.filter(
            (d) => d.ownerType === (v.ownerType ?? v.o) && (v.n === undefined || d.namespace === v.n) && (v.k === undefined || d.key === v.k),
          ),
        );
      case "products":
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
        const prefix = { PAGE: "Page", COLLECTION: "Collection", METAOBJECT: "Metaobject", MENU: "Menu", SHOP_POLICY: "ShopPolicy" }[v.type as string];
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
        const name = /filename:'(.*)'/.exec(v.q)?.[1];
        return conn(
          s.files
            .filter((f) => f.url && f.url.split("?")[0]!.endsWith(`/${name}`))
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
          const owner = [...s.products, ...s.collections].find((o) => o.id === m.ownerId);
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
    title: i.title,
    type: i.type,
    url: i.url ?? (i.resourceId ? `https://example.com/${i.resourceId}` : null),
    resourceId: i.resourceId ?? null,
    tags: i.tags ?? [],
    items: (i.items ?? []).map(toMenuNode),
  };
}
