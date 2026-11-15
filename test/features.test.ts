import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs, runCli } from "../src/cli.js";
import { StoreRegistry, type StoreConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { PlanStore } from "../src/plan.js";
import { filenameFromUrl } from "../src/refs.js";
import { parseThemeJson } from "../src/themes.js";
import { FakeShop } from "./fakeShop.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function engineFor(...shops: FakeShop[]) {
  process.env.SYNC_AUDIT_LOG = join(tmp("audit-"), "audit.log");
  const byAlias = Object.fromEntries(shops.map((s) => [s.store.alias, s]));
  return new Engine(new StoreRegistry(shops.map((s) => s.store)), new PlanStore(tmp("plans-")), (s: StoreConfig) => byAlias[s.alias]!);
}

async function sync(engine: Engine, source: string, target: string, resources: string[], extra: Record<string, unknown> = {}) {
  const plan = await engine.plan(source, target, { resources: resources as any, ...extra });
  const { results } = await engine.apply(plan.id);
  return { plan, results };
}

const mfDef = (id: string, ns: string, key: string) => ({
  id,
  name: key,
  namespace: ns,
  key,
  description: null,
  ownerType: "PRODUCT",
  pinnedPosition: null,
  type: { name: "single_line_text_field" },
  access: { storefront: "PUBLIC_READ", customerAccount: "NONE" },
  capabilities: { adminFilterable: { enabled: true }, smartCollectionCondition: { enabled: true }, uniqueValues: { enabled: false } },
  validations: [],
});

describe("collections", () => {
  it("copies smart collections with their rules, remapping metafield definition conditions", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      metafieldDefinitions: [mfDef("gid://shopify/MetafieldDefinition/5", "custom", "fabric")],
      collections: [
        {
          id: "gid://shopify/Collection/1",
          handle: "linen",
          title: "Linen",
          descriptionHtml: "<p>All linen</p>",
          sortOrder: "CREATED_DESC",
          templateSuffix: null,
          seo: { title: "Linen clothing", description: null },
          ruleSet: {
            appliedDisjunctively: false,
            rules: [
              { column: "TAG", relation: "EQUALS", condition: "linen", conditionObject: null },
              {
                column: "PRODUCT_METAFIELD_DEFINITION",
                relation: "EQUALS",
                condition: "linen",
                conditionObject: { __typename: "CollectionRuleMetafieldCondition", metafieldDefinition: { id: "gid://shopify/MetafieldDefinition/5" } },
              },
            ],
          },
        },
        { id: "gid://shopify/Collection/2", handle: "picks", title: "Staff picks", ruleSet: null },
      ],
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      metafieldDefinitions: [mfDef("gid://shopify/MetafieldDefinition/905", "custom", "fabric")],
      collections: [{ id: "gid://shopify/Collection/902", handle: "picks", title: "Picks", ruleSet: null }],
    });
    const engine = engineFor(dev, eu);
    const { plan, results } = await sync(engine, "dev", "eu", ["metafield_definitions", "collections"]);

    expect(plan.ops.filter((o) => o.kind === "collections").map((o) => `${o.action} ${o.key}`)).toEqual(["create linen", "update picks"]);
    expect(results.filter((r) => r.outcome === "failed")).toEqual([]);
    const linen = eu.state.collections.find((c) => c.handle === "linen")!;
    expect(linen.ruleSet!.rules).toEqual([
      { column: "TAG", relation: "EQUALS", condition: "linen" },
      { column: "PRODUCT_METAFIELD_DEFINITION", relation: "EQUALS", condition: "linen", conditionObjectId: "gid://shopify/MetafieldDefinition/905" },
    ]);
    expect(eu.state.collections.find((c) => c.handle === "picks")!.title).toBe("Staff picks");
  });

  it("reports manual versus smart as a conflict", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      collections: [{ id: "gid://shopify/Collection/1", handle: "sale", ruleSet: { appliedDisjunctively: false, rules: [] } }],
    });
    const eu = new FakeShop(FakeShop.config("eu"), { collections: [{ id: "gid://shopify/Collection/9", handle: "sale", ruleSet: null }] });
    const plan = await engineFor(dev, eu).plan("dev", "eu", { resources: ["collections"] });
    expect(plan.ops[0]).toMatchObject({ action: "conflict", reason: expect.stringMatching(/smart in source but manual in target/) });
  });
});

describe("shop policies", () => {
  it("copies policy text by type", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      shopPolicies: [
        { id: "gid://shopify/ShopPolicy/1", type: "REFUND_POLICY", body: "<p>30 days</p>" },
        { id: "gid://shopify/ShopPolicy/2", type: "PRIVACY_POLICY", body: "<p>We respect privacy</p>" },
      ],
    });
    const eu = new FakeShop(FakeShop.config("eu"), { shopPolicies: [{ id: "gid://shopify/ShopPolicy/9", type: "REFUND_POLICY", body: "<p>14 days</p>" }] });
    const { results } = await sync(engineFor(dev, eu), "dev", "eu", ["shop_policies"]);
    expect(results.map((r) => `${r.outcome} ${r.key}`)).toEqual(["created PRIVACY_POLICY", "updated REFUND_POLICY"]);
    expect(eu.state.shopPolicies.find((p) => p.type === "REFUND_POLICY")!.body).toBe("<p>30 days</p>");
  });

  it("says how to unblock a policy Shopify manages automatically", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), { shopPolicies: [{ id: "gid://shopify/ShopPolicy/2", type: "PRIVACY_POLICY", body: "<p>Ours</p>" }] });
    const eu = new FakeShop(FakeShop.config("eu"), {
      shopPolicies: [{ id: "gid://shopify/ShopPolicy/9", type: "PRIVACY_POLICY", body: "<p>Generated</p>", autoManaged: true }],
    });
    const { results } = await sync(engineFor(dev, eu), "dev", "eu", ["shop_policies"]);
    expect(results[0]!.outcome).toBe("failed");
    expect(results[0]!.message).toContain("managed automatically by Shopify in the target");
    expect(results[0]!.message).toContain("--exclude PRIVACY_POLICY");
  });
});

describe("metafield values", () => {
  function stores() {
    const dev = new FakeShop(FakeShop.config("dev"), {
      products: [
        {
          id: "gid://shopify/Product/1",
          handle: "linen-shirt",
          metafields: [
            { namespace: "custom", key: "material", type: "single_line_text_field", value: "Linen" },
            { namespace: "custom", key: "pairs_with", type: "product_reference", value: "gid://shopify/Product/2" },
            { namespace: "app--123--reviews", key: "rating", type: "number_decimal", value: "4.8" },
          ],
        },
        { id: "gid://shopify/Product/2", handle: "linen-trousers", metafields: [] },
        { id: "gid://shopify/Product/3", handle: "dev-only", metafields: [{ namespace: "custom", key: "material", type: "single_line_text_field", value: "Wool" }] },
      ],
      collections: [
        { id: "gid://shopify/Collection/1", handle: "linen", metafields: [{ namespace: "custom", key: "banner_text", type: "single_line_text_field", value: "Summer" }] },
      ],
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      products: [
        { id: "gid://shopify/Product/91", handle: "linen-shirt", metafields: [{ namespace: "custom", key: "material", type: "single_line_text_field", value: "Lin" }] },
        { id: "gid://shopify/Product/92", handle: "linen-trousers" },
      ],
      collections: [{ id: "gid://shopify/Collection/91", handle: "linen" }],
    });
    return { dev, eu };
  }

  it("lands values on the item with the same handle, with references remapped", async () => {
    const { dev, eu } = stores();
    const engine = engineFor(dev, eu);
    const { plan, results } = await sync(engine, "dev", "eu", ["metafields"]);

    expect(plan.skipped).toEqual([{ kind: "metafields", key: "PRODUCT/linen-shirt/app--123--reviews.rating", reason: "app-owned" }]);
    const orphan = plan.ops.find((o) => o.key === "PRODUCT/dev-only/custom.material")!;
    expect(orphan.action).toBe("conflict");
    expect(orphan.reason).toBe("Product/dev-only doesn't exist in the target; create it first");
    expect(plan.warnings[0]).toMatch(/^1 value\(s\) belong to something that doesn't exist in the target/);
    expect(plan.warnings.some((w) => /conflict\(s\) need a manual fix/.test(w))).toBe(false);
    expect(results.map((r) => `${r.outcome} ${r.key}`).sort()).toEqual([
      "created COLLECTION/linen/custom.banner_text",
      "created PRODUCT/linen-shirt/custom.pairs_with",
      "skipped PRODUCT/dev-only/custom.material",
      "updated PRODUCT/linen-shirt/custom.material",
    ]);
    const shirt = eu.state.products.find((p) => p.handle === "linen-shirt")!;
    expect(shirt.metafields).toEqual([
      { namespace: "custom", key: "material", type: "single_line_text_field", value: "Linen" },
      { namespace: "custom", key: "pairs_with", type: "product_reference", value: "gid://shopify/Product/92" },
    ]);
    expect(eu.state.collections[0]!.metafields).toEqual([{ namespace: "custom", key: "banner_text", type: "single_line_text_field", value: "Summer" }]);
  });

  it("is opt-in and can be limited to namespaces", async () => {
    const { dev, eu } = stores();
    const engine = engineFor(dev, eu);
    expect((await engine.plan("dev", "eu", {})).ops.some((o) => o.kind === "metafields")).toBe(false);
    const plan = await engine.plan("dev", "eu", { resources: ["metafields"], namespaces: ["custom"], include: ["COLLECTION/*"] });
    expect(plan.ops.map((o) => o.key)).toEqual(["COLLECTION/linen/custom.banner_text"]);
  });
});

describe("translations", () => {
  it("registers translations against the target's own content digests", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      shopLocales: [
        { locale: "en", primary: true },
        { locale: "fr", primary: false },
      ],
      pages: [{ id: "gid://shopify/Page/1", handle: "shipping", title: "Shipping", body: "<p>Free</p>", isPublished: true, templateSuffix: null }],
      translations: { "gid://shopify/Page/1": { fr: { title: "Livraison", body_html: "<p>Gratuite</p>" } } },
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      shopLocales: [
        { locale: "en", primary: true },
        { locale: "fr", primary: false },
      ],
      pages: [{ id: "gid://shopify/Page/91", handle: "shipping", title: "Shipping", body: "<p>Free</p>", isPublished: true, templateSuffix: null }],
      translatableContent: { "gid://shopify/Page/91": [{ key: "title", digest: "eu-t" }, { key: "body_html", digest: "eu-b" }] },
    });
    const engine = engineFor(dev, eu);
    const { plan, results } = await sync(engine, "dev", "eu", ["translations"]);
    expect(plan.warnings).toEqual([]);
    expect(plan.ops.map((o) => `${o.action} ${o.key}`)).toEqual(["create fr:Page/shipping"]);
    expect(results[0]!.outcome).toBe("created");
    expect(eu.state.translations["gid://shopify/Page/91"]).toEqual({ fr: { title: "Livraison", body_html: "<p>Gratuite</p>" } });

    // Re-running finds nothing left to do.
    expect((await engine.plan("dev", "eu", { resources: ["translations"] })).ops).toEqual([]);
  });

  it("explains when the target has no original text for a field", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      shopLocales: [{ locale: "fr", primary: false }],
      pages: [{ id: "gid://shopify/Page/1", handle: "about", title: "About", body: "x", isPublished: true, templateSuffix: null }],
      translations: { "gid://shopify/Page/1": { fr: { title: "A propos", body_html: "<p>x</p>" } } },
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      pages: [{ id: "gid://shopify/Page/9", handle: "about", title: "About", body: "", isPublished: true, templateSuffix: null }],
      translatableContent: { "gid://shopify/Page/9": [{ key: "title", digest: "d" }] },
    });
    const { plan, results } = await sync(engineFor(dev, eu), "dev", "eu", ["translations"]);
    expect(plan.warnings.join("\n")).toMatch(/Language\(s\) fr are not added to eu/);
    expect(results[0]).toMatchObject({ outcome: "failed", message: expect.stringMatching(/registered 1 of 2.*body_html/) });
    expect(eu.state.translations["gid://shopify/Page/9"]).toEqual({ fr: { title: "A propos" } });
  });
});

describe("files", () => {
  const def = (id: string) => ({
    id,
    type: "lookbook",
    name: "Lookbook",
    description: null,
    displayNameKey: null,
    access: { storefront: "PUBLIC_READ", customerAccount: "NONE" },
    capabilities: { publishable: { enabled: false }, translatable: { enabled: false }, renderable: { enabled: false }, onlineStore: { enabled: false, data: null } },
    fieldDefinitions: [{ key: "image", name: "Image", description: null, required: false, type: { name: "file_reference" }, validations: [], capabilities: { adminFilterable: { enabled: false } } }],
  });
  const entry = (id: string, handle: string, image: string) => ({ id, type: "lookbook", handle, fields: [{ key: "image", value: image }], capabilities: { publishable: null } });

  it("matches files by name and uploads the missing ones from the source", async () => {
    const cdn = "https://cdn.shopify.com/s/files/1/0001/files";
    const dev = new FakeShop(FakeShop.config("dev"), {
      files: [
        { id: "gid://shopify/MediaImage/1", url: `${cdn}/hero.jpg?v=1`, alt: "Hero" },
        { id: "gid://shopify/MediaImage/2", url: `${cdn}/summer%20look.jpg?v=3`, alt: "Summer" },
      ],
      metaobjectDefinitions: [def("gid://shopify/MetaobjectDefinition/1")],
      metaobjects: [entry("gid://shopify/Metaobject/1", "hero", "gid://shopify/MediaImage/1"), entry("gid://shopify/Metaobject/2", "summer", "gid://shopify/MediaImage/2")],
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      files: [{ id: "gid://shopify/MediaImage/901", url: "https://cdn.shopify.com/s/files/1/0009/files/hero.jpg?v=7" }],
      metaobjectDefinitions: [def("gid://shopify/MetaobjectDefinition/9")],
    });
    const engine = engineFor(dev, eu);
    const { plan, results } = await sync(engine, "dev", "eu", ["metaobjects"]);

    expect(plan.warnings.join("\n")).toMatch(/1 file\(s\) don't exist in the target and will be uploaded/);
    expect(Object.keys(plan.files)).toEqual(["shopify://File/summer look.jpg"]);
    expect(results.map((r) => r.outcome)).toEqual(["created", "created"]);
    const value = (h: string) => eu.state.metaobjects.find((o) => o.handle === h)!.fields[0].value;
    expect(value("hero")).toBe("gid://shopify/MediaImage/901");
    const uploaded = eu.state.files.find((f) => f.url === `${cdn}/summer%20look.jpg?v=3`)!;
    expect(value("summer")).toBe(uploaded.id);
    expect(uploaded.alt).toBe("Summer");
  });

  it("derives the file name Shopify shows from a CDN URL", () => {
    expect(filenameFromUrl("https://cdn.shopify.com/s/files/1/2/files/size%20chart.png?v=17")).toBe("size chart.png");
  });
});

describe("config as code", () => {
  function stores() {
    const dev = new FakeShop(FakeShop.config("dev"), {
      pages: [{ id: "gid://shopify/Page/1", handle: "faq", title: "FAQ", body: "<p>Q&A</p>", isPublished: true, templateSuffix: null }],
      redirects: [{ id: "gid://shopify/UrlRedirect/1", path: "/old/faq", target: "/pages/faq" }],
    });
    const eu = new FakeShop(FakeShop.config("eu"));
    return { dev, eu };
  }

  it("exports one sorted JSON file per item and plans from the folder like from the store", async () => {
    const { dev, eu } = stores();
    const engine = engineFor(dev, eu);
    const dir = join(tmp("snap-"), "dev-config");
    const res = await engine.export("dev", dir, { resources: ["pages", "redirects"] });
    expect(res.files).toBe(2);
    expect(readdirSync(join(dir, "redirects"))).toEqual(["old_faq.json"]);
    expect(JSON.parse(readFileSync(join(dir, "pages", "faq.json"), "utf8"))).toEqual({
      data: { body: "<p>Q&A</p>", handle: "faq", isPublished: true, title: "FAQ" },
      key: "faq",
    });

    const fromStore = await engine.plan("dev", "eu", { resources: ["pages", "redirects"] });
    const fromDir = await engine.plan(`dir:${dir}`, "eu", { resources: ["pages", "redirects"] });
    const shape = (p: typeof fromStore) => p.ops.map((o) => [o.action, o.kind, o.key, o.data]);
    expect(shape(fromDir)).toEqual(shape(fromStore));
    expect(fromDir.source.alias).toBe(`dir:${dir}`);
  });

  it("detects drift between a store and its committed snapshot", async () => {
    const { dev, eu } = stores();
    const engine = engineFor(dev, eu);
    const dir = join(tmp("snap-"), "cfg");
    await engine.export("dev", dir, { resources: ["pages"] });
    dev.state.pages[0]!.title = "Frequently asked questions";
    const { diffs } = await engine.compare(`dir:${dir}`, "dev", { resources: ["pages"] });
    expect(diffs[0]!.changed[0]!.changes).toEqual([{ path: "title", source: "FAQ", target: "Frequently asked questions" }]);
  });

  it("refuses to export into a folder that holds other files, and to sync into a folder", async () => {
    const { dev, eu } = stores();
    const engine = engineFor(dev, eu);
    const dir = tmp("busy-");
    writeFileSync(join(dir, "notes.txt"), "mine");
    await expect(engine.export("dev", dir, {})).rejects.toThrow(/not empty and is not a snapshot folder/);
    await expect(engine.plan("dev", `dir:${dir}`, {})).rejects.toThrow(/target of a sync must be a store/);
  });
});

describe("theme settings diff", () => {
  it("compares JSON templates and settings of the published themes, read-only", async () => {
    const header = "/* This file is auto-generated */\n";
    const dev = new FakeShop(FakeShop.config("dev"), {
      themes: [
        {
          id: "gid://shopify/OnlineStoreTheme/1",
          name: "Dawn dev",
          role: "MAIN",
          files: {
            "templates/product.json": header + JSON.stringify({ sections: { main: { type: "main-product", settings: { show_vendor: true } } } }),
            "templates/page.faq.json": JSON.stringify({ sections: {} }),
            "config/settings_data.json": JSON.stringify({ current: { colors_accent: "#1a7f37" } }),
            "assets/base.css": "body{}",
          },
        },
      ],
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      themes: [
        {
          id: "gid://shopify/OnlineStoreTheme/9",
          name: "Dawn EU",
          role: "MAIN",
          files: {
            "templates/product.json": JSON.stringify({ sections: { main: { type: "main-product", settings: { show_vendor: false } } } }),
            "config/settings_data.json": JSON.stringify({ current: { colors_accent: "#1a7f37" } }),
            "templates/collection.json": "{}",
          },
        },
      ],
    });
    const d = await engineFor(dev, eu).themes("dev", "eu", {});
    expect(d.source.name).toBe("Dawn dev");
    expect(d.onlyInSource).toEqual(["templates/page.faq.json"]);
    expect(d.onlyInTarget).toEqual(["templates/collection.json"]);
    expect(d.changed).toEqual([{ file: "templates/product.json", changes: [{ path: "sections.main.settings.show_vendor", source: true, target: false }] }]);
    expect(d.identical).toBe(1);
    expect(eu.mutations()).toEqual([]);
  });

  it("parses theme JSON with a leading comment", () => {
    expect(parseThemeJson("/* hi */ {\"a\":1}")).toEqual({ a: 1 });
  });
});

describe("CLI", () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  });

  it("parses flags", () => {
    expect(parseArgs(["diff", "dev", "eu", "--resources", "pages,menus", "--json", "--include=faq*"])).toEqual({
      positional: ["diff", "dev", "eu"],
      flags: { resources: "pages,menus", json: true, include: "faq*" },
    });
  });

  it("runs diff, plan, apply and export through the same engine", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), { redirects: [{ id: "gid://shopify/UrlRedirect/1", path: "/a", target: "/b" }] });
    const eu = new FakeShop(FakeShop.config("eu", { protected: true }));
    const engine = engineFor(dev, eu);

    expect(await runCli(["diff", "dev", "eu", "--resources", "redirects", "--exit-code"], {}, engine)).toBe(2);
    expect(logs.join("\n")).toMatch(/\+ \/a/);

    logs = [];
    expect(await runCli(["plan", "dev", "eu", "--resources", "redirects", "--json"], {}, engine)).toBe(0);
    const plan = JSON.parse(logs.join("\n"));
    expect(plan.totals).toEqual({ create: 1, update: 0, conflict: 0 });

    logs = [];
    expect(await runCli(["apply", plan.plan_id], {}, engine)).toBe(1);
    expect(logs.join("\n")).toMatch(/Refused: .*protected/);
    expect(await runCli(["apply", plan.plan_id, "--confirm", "eu.myshopify.com"], {}, engine)).toBe(0);
    expect(eu.state.redirects.map((r) => r.path)).toEqual(["/a"]);

    const dir = join(tmp("cli-"), "snap");
    expect(await runCli(["export", "dev", dir, "--resources", "redirects"], {}, engine)).toBe(0);
    expect(existsSync(join(dir, "snapshot.json"))).toBe(true);
    expect(await runCli(["diff", `dir:${dir}`, "eu", "--resources", "redirects", "--exit-code"], {}, engine)).toBe(0);
  });

  it("rejects unknown resources with a helpful message", async () => {
    expect(await runCli(["diff", "dev", "eu", "--resources", "orders"], {}, engineFor(new FakeShop(FakeShop.config("dev")), new FakeShop(FakeShop.config("eu"))))).toBe(1);
    expect(logs.join("\n")).toMatch(/unknown resource "orders"/);
  });
});
