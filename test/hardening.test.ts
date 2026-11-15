import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StoreRegistry, type StoreConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { PLAN_KEEP_MS, PlanStore } from "../src/plan.js";
import { isShopifyFileUrl, RefToGidResolver } from "../src/refs.js";
import { alignMenuItems, mergeMenuItems, targetOnlyMenuItems } from "../src/resources/menus.js";
import { paginate, ShopifyAdminClient, type FetchLike } from "../src/shopify/client.js";
import { readSnapshot, SNAPSHOT_FORMAT } from "../src/snapshotFiles.js";
import { FakeShop, type FakeProduct } from "./fakeShop.js";

/*
 * One test (or more) per finding of the 0.4.0 audit: what the tool promises ("never deletes",
 * "a person confirms", "a snapshot folder is just data") has to hold when something is in the way.
 */

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const cdn = "https://cdn.shopify.com/s/files/1/0001/files";

function engineFor(...shops: FakeShop[]) {
  process.env.SYNC_AUDIT_LOG = join(tmp("audit-"), "audit.log");
  const byAlias = Object.fromEntries(shops.map((s) => [s.store.alias, s]));
  return new Engine(new StoreRegistry(shops.map((s) => s.store)), new PlanStore(tmp("plans-")), (s: StoreConfig) => byAlias[s.alias]!);
}

const link = (title: string, url: string, items: any[] = []) => ({ title, type: "HTTP", url, resourceId: null, tags: [], items });
const titles = (items: any[]): any[] => items.map((i) => (i.items?.length ? [i.title, titles(i.items)] : i.title));

describe("menus keep the links only the target has", () => {
  const menu = (id: string, items: any[]) => ({ id, handle: "main-menu", title: "Main menu", items });

  it("updates a menu without removing the target's own links, at any depth", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      menus: [menu("gid://shopify/Menu/1", [link("Home", "/"), link("Shop", "/collections/all", [link("New in", "/collections/new")]), link("Journal", "/blogs/journal")])],
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      menus: [
        menu("gid://shopify/Menu/9", [
          link("Home", "/"),
          link("EU only: Sale", "/collections/sale"),
          link("Shop", "/collections/all", [link("Outlet (EU)", "/collections/outlet")]),
        ]),
      ],
    });
    const engine = engineFor(dev, eu);
    const plan = await engine.plan("dev", "eu", { resources: ["menus"] });

    expect(plan.ops.map((o) => `${o.action} ${o.key}`)).toEqual(["update main-menu"]);
    expect(plan.warnings).toContain('menus main-menu: 2 link(s) that only the target has will be kept: "EU only: Sale", "Shop > Outlet (EU)"');
    const { results } = await engine.apply(plan.id);
    expect(results.map((r) => r.outcome)).toEqual(["updated"]);

    // Source order, with each target-only link staying where it was: after the item it followed, or first.
    expect(titles(eu.state.menus[0].items)).toEqual(["Home", "EU only: Sale", ["Shop", ["Outlet (EU)", "New in"]], "Journal"]);
    // Existing items are updated in place (their ids are sent back), not recreated.
    const sent = eu.calls.find((c) => c.field === "menuUpdate")!.variables.items;
    expect(sent.map((i: any) => Boolean(i.id))).toEqual([true, true, true, false]);

    // And then it settles: what the target keeps is not a difference.
    expect((await engine.plan("dev", "eu", { resources: ["menus"] })).ops).toEqual([]);
  });

  it("treats a menu that only has extra links as already in line", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), { menus: [menu("gid://shopify/Menu/1", [link("Home", "/")])] });
    const eu = new FakeShop(FakeShop.config("eu"), { menus: [menu("gid://shopify/Menu/9", [link("Promo", "/promo"), link("Home", "/")])] });
    expect((await engineFor(dev, eu).plan("dev", "eu", { resources: ["menus"] })).ops).toEqual([]);
  });

  it("matches links by what they point at, so a renamed link is an update and not a second link", () => {
    const source = [{ title: "About us", type: "PAGE", resourceId: "p1" }, { title: "Blog", type: "HTTP", url: "/blog" }];
    const target = [
      { id: "i1", title: "About", type: "PAGE", resourceId: "p1", url: "https://x/pages/about" },
      { id: "i2", title: "Careers", type: "HTTP", url: "/careers" },
    ];
    expect(mergeMenuItems(source, target)).toEqual([
      { id: "i1", title: "About us", type: "PAGE", resourceId: "p1" },
      { id: "i2", title: "Careers", type: "HTTP", url: "/careers" },
      { title: "Blog", type: "HTTP", url: "/blog" },
    ]);
    expect(targetOnlyMenuItems(source, target)).toEqual(["Careers"]);
    expect(alignMenuItems(source, target as any).map((i) => i.title)).toEqual(["About"]);
  });
});

describe("products keep what only the target has", () => {
  const product = (id: string, extra: Partial<FakeProduct> = {}): FakeProduct => ({
    id,
    handle: "linen-shirt",
    title: "Linen shirt",
    tags: ["linen", "summer"],
    options: [{ name: "Size", values: ["M"] }],
    variants: [{ id: `${id}-1`, options: { Size: "M" }, sku: "LS-M" }],
    ...extra,
  });

  it("keeps the target's tags, videos and 3D models when a product is updated", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      files: [{ id: "gid://shopify/MediaImage/1", url: `${cdn}/front.jpg` }],
      products: [product("gid://shopify/Product/1", { title: "Linen shirt, relaxed fit", tags: ["linen", "summer", "new"], media: ["gid://shopify/MediaImage/1"] })],
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      files: [
        { id: "gid://shopify/MediaImage/91", url: `${cdn}/front.jpg` },
        { id: "gid://shopify/Video/92", kind: "Video" },
        { id: "gid://shopify/Model3d/93", kind: "Model3d" },
        { id: "gid://shopify/ExternalVideo/94", kind: "ExternalVideo" },
      ],
      products: [
        product("gid://shopify/Product/9", {
          tags: ["linen", "eu-campaign"],
          media: ["gid://shopify/MediaImage/91", "gid://shopify/Video/92", "gid://shopify/Model3d/93", "gid://shopify/ExternalVideo/94"],
        }),
      ],
    });
    const engine = engineFor(dev, eu);
    const plan = await engine.plan("dev", "eu", { resources: ["products"] });
    // The target's own tag and media aren't differences; the tags it lacks are.
    expect(plan.ops[0]!.changes!.map((c) => c.path)).toEqual(["tags", "title"]);
    await engine.apply(plan.id);

    const p = eu.state.products[0]!;
    expect([...p.tags!].sort()).toEqual(["eu-campaign", "linen", "new", "summer"]);
    expect(p.media).toEqual(["gid://shopify/MediaImage/91", "gid://shopify/Video/92", "gid://shopify/Model3d/93", "gid://shopify/ExternalVideo/94"]);
    expect((await engine.plan("dev", "eu", { resources: ["products"] })).ops).toEqual([]);
  });

  it("reads every variant and every media item, however many pages they take", async () => {
    const sizes = Array.from({ length: 7 }, (_, i) => `S${i}`);
    const files = Array.from({ length: 5 }, (_, i) => ({ id: `gid://shopify/MediaImage/${50 + i}`, url: `${cdn}/eu-${i}.jpg` }));
    const dev = new FakeShop(FakeShop.config("dev"), {
      pageSize: 2,
      products: [product("gid://shopify/Product/1", { title: "Renamed", options: [{ name: "Size", values: sizes }], variants: sizes.map((s, i) => ({ id: `v${i}`, options: { Size: s }, sku: `LS-${s}` })) })],
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      pageSize: 2,
      files,
      products: [
        product("gid://shopify/Product/9", {
          options: [{ name: "Size", values: sizes }],
          variants: sizes.map((s, i) => ({ id: `eu${i}`, options: { Size: s }, sku: `LS-${s}` })),
          media: files.map((f) => f.id),
        }),
      ],
    });
    const engine = engineFor(dev, eu);
    const { snapshot } = await engine.snapshot("dev", { resources: ["products"] });
    expect((snapshot.resources.products!.items[0]!.data.variants as unknown[]).length).toBe(7);

    const plan = await engine.plan("dev", "eu", { resources: ["products"] });
    expect(plan.ops[0]!.changes!.map((c) => c.path)).toEqual(["title"]);
    await engine.apply(plan.id);
    // All five target images were read (three pages) and sent back, so none was detached.
    expect(eu.state.products[0]!.media).toEqual(files.map((f) => f.id));
    expect(eu.state.products[0]!.variants!.map((v) => v.id)).toEqual(sizes.map((_, i) => `eu${i}`));
  });

  it("copies the category, the taxable flag and the inventory policy", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      products: [product("gid://shopify/Product/1", { category: "aa-1-13-8", variants: [{ id: "v", options: { Size: "M" }, sku: "LS-M", taxable: false, inventoryPolicy: "CONTINUE" }] })],
    });
    const eu = new FakeShop(FakeShop.config("eu"), { products: [product("gid://shopify/Product/9", { category: "aa-1" })] });
    const engine = engineFor(dev, eu);
    const plan = await engine.plan("dev", "eu", { resources: ["products"] });
    expect(plan.ops[0]!.changes!.map((c) => c.path)).toEqual(["category", "variants[0].inventoryPolicy", "variants[0].taxable"]);
    await engine.apply(plan.id);
    expect(eu.state.products[0]).toMatchObject({ category: "aa-1-13-8", variants: [{ taxable: false, inventoryPolicy: "CONTINUE" }] });

    // A category only the target has is left alone.
    const bare = new FakeShop(FakeShop.config("bare"), { products: [product("gid://shopify/Product/2")] });
    expect((await engineFor(bare, eu).plan("bare", "eu", { resources: ["products"] })).ops[0]!.changes!.map((c) => c.path)).not.toContain("category");
  });
});

describe("snapshot folders are checked like any other input", () => {
  function folder(manifest: Record<string, unknown>, items: Record<string, unknown> = {}) {
    const dir = tmp("snap-");
    writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ format: SNAPSHOT_FORMAT, domain: "dev.myshopify.com", takenAt: "2026-11-01T00:00:00Z", resources: [], ...manifest }));
    for (const [path, body] of Object.entries(items)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), typeof body === "string" ? body : JSON.stringify(body));
    }
    return dir;
  }

  it("won't follow a manifest out of the folder", () => {
    const outside = tmp("outside-");
    writeFileSync(join(outside, "secret.json"), JSON.stringify({ key: "leak", data: { token: "x" } }));
    const dir = folder({ resources: [`../${outside.split("/").pop()}`] });
    expect(() => readSnapshot(dir)).toThrow(/snapshot\.json: resources\.0/);
    expect(() => readSnapshot(folder({ resources: ["orders"] }))).toThrow(/resources\.0/);
  });

  it("rejects item files that aren't items, naming the file", () => {
    expect(() => readSnapshot(folder({ resources: ["pages"] }, { "pages/a.json": { key: "a" } }))).toThrow(/pages[\\/]a\.json: data/);
    expect(() => readSnapshot(folder({ resources: ["pages"] }, { "pages/a.json": "{ not json" }))).toThrow(/a\.json is not valid JSON/);
    expect(() => readSnapshot(folder({ format: "something/9" }))).toThrow(/snapshot\.json: format/);
  });

  it("only accepts file URLs on Shopify's own hosts, in the manifest and at upload time", async () => {
    expect(isShopifyFileUrl(`${cdn}/a.jpg?v=1`)).toBe(true);
    expect(isShopifyFileUrl("https://my-store.myshopify.com/cdn/shop/files/a.jpg")).toBe(true);
    for (const bad of ["http://cdn.shopify.com/a.jpg", "https://cdn.shopify.com.evil.example/a.jpg", "https://169.254.169.254/latest/meta-data", "file:///etc/passwd", "nope"]) {
      expect(isShopifyFileUrl(bad)).toBe(false);
    }
    const files = { "shopify://File/a.jpg": { url: "https://evil.example/a.jpg", contentType: "IMAGE" } };
    expect(() => readSnapshot(folder({ files }))).toThrow(/file URLs must be https URLs on cdn\.shopify\.com/);

    // Even if a plan carried such a URL, the upload itself refuses it.
    const eu = new FakeShop(FakeShop.config("eu"));
    const resolver = new RefToGidResolver(eu, new Map(Object.entries(files)) as any);
    await expect(resolver.resolve("shopify://File/a.jpg")).rejects.toThrow(/not on a Shopify file host/);
    expect(eu.mutations()).toEqual([]);
  });
});

describe("a difference that can't be removed is not a difference", () => {
  const def = {
    id: "gid://shopify/MetaobjectDefinition/1",
    type: "faq",
    name: "FAQ",
    description: null,
    displayNameKey: "q",
    access: { storefront: "PUBLIC_READ", customerAccount: "NONE" },
    capabilities: { publishable: { enabled: true }, translatable: { enabled: true }, renderable: { enabled: false }, onlineStore: { enabled: false, data: null } },
    fieldDefinitions: ["q", "a"].map((key) => ({ key, name: key, description: null, required: false, type: { name: "single_line_text_field" }, validations: [], capabilities: { adminFilterable: { enabled: false } } })),
  };
  const entry = (id: string, fields: Record<string, string>, status = "ACTIVE") => ({
    id,
    type: "faq",
    handle: "x",
    fields: Object.entries(fields).map(([key, value]) => ({ key, value })),
    capabilities: { publishable: { status } },
  });

  it("settles when the target entry has a value in a field the source leaves empty", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), { metaobjectDefinitions: [def], metaobjects: [entry("gid://shopify/Metaobject/1", { q: "New question" })] });
    const eu = new FakeShop(FakeShop.config("eu"), {
      metaobjectDefinitions: [{ ...def, id: "gid://shopify/MetaobjectDefinition/9" }],
      metaobjects: [entry("gid://shopify/Metaobject/9", { q: "Old question", a: "EU answer" })],
    });
    const engine = engineFor(dev, eu);
    const plan = await engine.plan("dev", "eu", { resources: ["metaobjects"] });
    expect(plan.ops[0]!.changes!.map((c) => c.path)).toEqual(["fields.q"]);
    await engine.apply(plan.id);
    expect(eu.state.metaobjects[0].fields).toEqual([{ key: "q", value: "New question" }, { key: "a", value: "EU answer" }]);
    expect((await engine.plan("dev", "eu", { resources: ["metaobjects"] })).ops).toEqual([]);
  });

  it("settles when the target has a translated field the source doesn't", async () => {
    const page = (id: string) => ({ id, handle: "about", title: "About", body: "x", isPublished: true, templateSuffix: null });
    const dev = new FakeShop(FakeShop.config("dev"), {
      pages: [page("gid://shopify/Page/1")],
      shopLocales: [{ locale: "en", primary: true }, { locale: "fr", primary: false }],
      translations: { "gid://shopify/Page/1": { fr: { title: "À propos" } } },
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      pages: [page("gid://shopify/Page/9")],
      shopLocales: [{ locale: "en", primary: true }, { locale: "fr", primary: false }],
      translations: { "gid://shopify/Page/9": { fr: { title: "À propos", body_html: "Texte propre à l'UE" } } },
    });
    expect((await engineFor(dev, eu).plan("dev", "eu", { resources: ["translations"] })).ops).toEqual([]);
  });

  it("with as_drafts, creates entries as drafts and leaves the published state of existing ones alone", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      metaobjectDefinitions: [def],
      metaobjects: [entry("gid://shopify/Metaobject/1", { q: "Q1 new" }), { ...entry("gid://shopify/Metaobject/2", { q: "Q2" }), handle: "y" }],
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      metaobjectDefinitions: [{ ...def, id: "gid://shopify/MetaobjectDefinition/9" }],
      metaobjects: [entry("gid://shopify/Metaobject/9", { q: "Q1" }, "DRAFT")],
    });
    const engine = engineFor(dev, eu);
    const plan = await engine.plan("dev", "eu", { resources: ["metaobjects"], drafts: true });
    // The entry that is a draft in the target and active in the source differs only by its text.
    expect(plan.ops.map((o) => [o.action, o.key, o.changes?.map((c) => c.path)])).toEqual([
      ["create", "faq/y", undefined],
      ["update", "faq/x", ["fields.q"]],
    ]);
    await engine.apply(plan.id);
    const status = (handle: string) => eu.state.metaobjects.find((o) => o.handle === handle).capabilities.publishable.status;
    expect([status("x"), status("y")]).toEqual(["DRAFT", "DRAFT"]);

    // Without it, the status is part of what is synced.
    const live = await engine.plan("dev", "eu", { resources: ["metaobjects"] });
    expect(live.ops.map((o) => [o.key, o.changes?.map((c) => c.path)])).toEqual([["faq/x", ["status"]], ["faq/y", ["status"]]]);
  });
});

describe("reads fail loudly instead of coming back short", () => {
  it("stops with an error when a list is longer than the limit", async () => {
    const eu = new FakeShop(FakeShop.config("eu"));
    let n = 0;
    eu.request = (async () => ({ things: { nodes: [n++, n++], pageInfo: { hasNextPage: true, endCursor: String(n) } } })) as any;
    await expect(paginate(eu, "query Things($after: String) { things }", {}, (d) => d.things, 6)).rejects.toThrow(
      "eu.myshopify.com: Things has more than 6 items, so the read was stopped. Narrow it (include, namespaces, metaobject_types) or raise SYNC_MAX_ITEMS.",
    );
  });

  it("finds a menu past the first page of menus", async () => {
    const eu = new FakeShop(FakeShop.config("eu"));
    const all = Array.from({ length: 150 }, (_, i) => ({ id: `gid://shopify/Menu/${i}`, handle: `menu-${i}` }));
    eu.request = (async (_q: string, v: { after?: string | null }) => {
      const start = v.after ? Number(v.after) : 0;
      return { menus: { nodes: all.slice(start, start + 100), pageInfo: { hasNextPage: start + 100 < all.length, endCursor: String(start + 100) } } };
    }) as any;
    await expect(new RefToGidResolver(eu).resolve("shopify://Menu/menu-149")).resolves.toBe("gid://shopify/Menu/149");
  });

  it("gives up on a request that never answers: reads are asked again, writes are not repeated", async () => {
    const store = FakeShop.config("s");
    let calls = 0;
    const never: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        calls++;
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      });
    const client = new ShopifyAdminClient(store, never, 5, 30);
    await expect(client.request("query { shop { name } }")).rejects.toThrow(/s\.myshopify\.com: no answer after 0s \(set SYNC_REQUEST_TIMEOUT_MS/);
    expect(calls).toBe(3);
    calls = 0;
    await expect(client.request("mutation { pageCreate { page { id } } }")).rejects.toThrow(/The write may or may not have been saved; plan again/);
    expect(calls).toBe(1);
  });
});

describe("applying", () => {
  it("writes independent items a few at a time, but never two values of the same product at once", async () => {
    const metafields = (n: number) => Array.from({ length: n }, (_, i) => ({ namespace: "custom", key: `k${i}`, type: "single_line_text_field", value: `v${i}` }));
    const dev = new FakeShop(FakeShop.config("dev"), {
      products: Array.from({ length: 6 }, (_, i) => ({ id: `gid://shopify/Product/${i + 1}`, handle: `p${i}`, metafields: metafields(3) })),
    });
    const eu = new FakeShop(FakeShop.config("eu"), { products: Array.from({ length: 6 }, (_, i) => ({ id: `gid://shopify/Product/${i + 91}`, handle: `p${i}` })) });

    // Make writes take a moment, and watch how many run at once overall and per product.
    const real = eu.request.bind(eu);
    let running = 0;
    let peak = 0;
    const perOwner = new Map<string, number>();
    let ownerPeak = 0;
    eu.request = (async (q: string, v: any) => {
      if (!/^\s*mutation/.test(q)) return real(q, v);
      const owner = v.m[0].ownerId as string;
      running++;
      perOwner.set(owner, (perOwner.get(owner) ?? 0) + 1);
      peak = Math.max(peak, running);
      ownerPeak = Math.max(ownerPeak, perOwner.get(owner)!);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      perOwner.set(owner, perOwner.get(owner)! - 1);
      return real(q, v);
    }) as any;

    const engine = engineFor(dev, eu);
    const plan = await engine.plan("dev", "eu", { resources: ["metafields"] });
    const { results } = await engine.apply(plan.id);
    expect(results.map((r) => r.outcome)).toEqual(Array(18).fill("created"));
    expect(results.map((r) => r.seq)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(peak).toBe(4);
    expect(ownerPeak).toBe(1);
    expect(eu.state.products.every((p) => p.metafields!.length === 3)).toBe(true);
  });

  it("uploads a file once even when several items written together need it", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      files: [{ id: "gid://shopify/MediaImage/1", url: `${cdn}/shared.jpg` }],
      products: [1, 2, 3].map((i) => ({ id: `gid://shopify/Product/${i}`, handle: `p${i}`, title: `P${i}`, media: ["gid://shopify/MediaImage/1"] })),
    });
    const eu = new FakeShop(FakeShop.config("eu"));
    const engine = engineFor(dev, eu);
    const plan = await engine.plan("dev", "eu", { resources: ["products"] });
    await engine.apply(plan.id);
    expect(eu.mutations().filter((m) => m === "fileCreate")).toHaveLength(1);
    expect(new Set(eu.state.products.map((p) => p.media![0])).size).toBe(1);
  });

  it("updates a redirect that points somewhere else", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), { redirects: [{ id: "gid://shopify/UrlRedirect/1", path: "/old", target: "/new-home" }] });
    const eu = new FakeShop(FakeShop.config("eu"), { redirects: [{ id: "gid://shopify/UrlRedirect/9", path: "/old", target: "/somewhere" }] });
    const engine = engineFor(dev, eu);
    const plan = await engine.plan("dev", "eu", { resources: ["redirects"] });
    expect(plan.ops.map((o) => [o.action, o.key, o.changes])).toEqual([["update", "/old", [{ path: "target", source: "/new-home", target: "/somewhere" }]]]);
    await engine.apply(plan.id);
    expect(eu.state.redirects).toEqual([{ id: "gid://shopify/UrlRedirect/9", path: "/old", target: "/new-home" }]);
  });

  it("says that new collections are not on any sales channel yet", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), { collections: [{ id: "gid://shopify/Collection/1", handle: "linen" }] });
    const plan = await engineFor(dev, new FakeShop(FakeShop.config("eu"))).plan("dev", "eu", { resources: ["collections"] });
    expect(plan.warnings.join("\n")).toMatch(/1 new collection\(s\) will not be published to any sales channel/);
  });
});

describe("metafield values of named products", () => {
  it("reads only the products the include patterns name, not the whole catalog", async () => {
    const mf = [{ namespace: "custom", key: "material", type: "single_line_text_field", value: "Linen" }];
    const dev = new FakeShop(FakeShop.config("dev"), {
      products: Array.from({ length: 40 }, (_, i) => ({ id: `gid://shopify/Product/${i + 1}`, handle: `p${i}`, metafields: mf })),
      collections: [{ id: "gid://shopify/Collection/1", handle: "linen", metafields: mf }],
    });
    const engine = engineFor(dev, new FakeShop(FakeShop.config("eu")));
    const { snapshot } = await engine.snapshot("dev", { resources: ["metafields"], include: ["PRODUCT/p3/*", "PRODUCT/p7/custom.material"] });
    expect(snapshot.resources.metafields!.items.map((i) => i.key).sort()).toEqual(["PRODUCT/p3/custom.material", "PRODUCT/p7/custom.material"]);
    expect(dev.calls.map((c) => c.field).filter((f) => f !== "nodes").sort()).toEqual(["productByIdentifier", "productByIdentifier"]);

    expect(Engine.metafieldOwners(["PRODUCT/p3/*", "COLLECTION/linen/custom.x"])).toEqual({ PRODUCT: ["p3"], COLLECTION: ["linen"] });
    // Anything that doesn't name its owner means a full read.
    for (const broad of [["PRODUCT/*"], ["PRODUCT/p*/custom.x"], ["faq/*", "PRODUCT/p3/*"], []]) expect(Engine.metafieldOwners(broad)).toBeUndefined();
  });
});

describe("plans on disk", () => {
  const plan = (id: string) => ({ id, createdAt: "", expiresAt: "", source: { alias: "a", domain: "a" }, target: { alias: "b", domain: "b" }, kinds: [], ops: [], onlyInTarget: [], skipped: [], warnings: [], files: {}, status: "pending" as const });

  it("removes plan files older than a week when a new plan is saved", () => {
    const dir = tmp("plans-");
    const old = "00000000-0000-4000-8000-000000000001";
    const recent = "00000000-0000-4000-8000-000000000002";
    const store = new PlanStore(dir);
    store.save(plan(old));
    store.save(plan(recent));
    const longAgo = new Date(Date.now() - PLAN_KEEP_MS - 60_000);
    utimesSync(join(dir, `${old}.json`), longAgo, longAgo);
    writeFileSync(join(dir, "notes.txt"), "not a plan");

    store.save(plan("00000000-0000-4000-8000-000000000003"));
    expect(readdirSync(dir).sort()).toEqual(["00000000-0000-4000-8000-000000000002.json", "00000000-0000-4000-8000-000000000003.json", "notes.txt"]);
    expect(store.get(old)).toBeUndefined();
  });

  it("treats a damaged plan file as no plan instead of crashing the list", () => {
    const dir = tmp("plans-");
    new PlanStore(dir).save(plan("00000000-0000-4000-8000-000000000001"));
    writeFileSync(join(dir, "00000000-0000-4000-8000-000000000002.json"), '{ "id": "00000000-0000-4000-8000-0000');
    writeFileSync(join(dir, "00000000-0000-4000-8000-000000000003.json"), '{"id":"someone-else"}');
    const fresh = new PlanStore(dir);
    expect(fresh.list().map((p) => p.id)).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(fresh.get("00000000-0000-4000-8000-000000000002")).toBeUndefined();
  });
});

describe("command line entry point", () => {
  const entry = join(__dirname, "..", "src", "index.ts");
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", entry, ...args], { encoding: "utf8", env: { ...process.env, SHOPIFY_STORES: "{}" }, timeout: 20_000 });

  it("rejects a mistyped command instead of starting the server and waiting forever", () => {
    const res = run("dif", "dev", "eu");
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/unknown command "dif"\. Commands: connect, stores, diff/);
    expect(res.stdout).toBe("");
  });

  it("prints the version from package.json", () => {
    const version = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version;
    expect(execFileSync(process.execPath, ["--import", "tsx", entry, "--version"], { encoding: "utf8" }).trim()).toBe(version);
    expect(existsSync(entry)).toBe(true);
  });
});
