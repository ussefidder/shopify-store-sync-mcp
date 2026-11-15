import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StoreRegistry, type StoreConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { PlanStore } from "../src/plan.js";
import { FakeShop, type FakeProduct } from "./fakeShop.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const cdn = "https://cdn.shopify.com/s/files/1/0001/files";

function engineFor(...shops: FakeShop[]) {
  process.env.SYNC_AUDIT_LOG = join(tmp("audit-"), "audit.log");
  const byAlias = Object.fromEntries(shops.map((s) => [s.store.alias, s]));
  return new Engine(new StoreRegistry(shops.map((s) => s.store)), new PlanStore(tmp("plans-")), (s: StoreConfig) => byAlias[s.alias]!);
}

const shirt = (id: string, extra: Partial<FakeProduct> = {}): FakeProduct => ({
  id,
  handle: "linen-shirt",
  title: "Linen shirt",
  descriptionHtml: "<p>Breathable linen.</p>",
  vendor: "Atelier",
  productType: "Shirts",
  tags: ["summer", "linen"],
  seo: { title: "Linen shirt", description: "Light and breathable" },
  options: [
    { name: "Color", values: ["Sand", "Navy"] },
    { name: "Size", values: ["M"] },
  ],
  variants: [
    { id: `${id}-1`, options: { Color: "Sand", Size: "M" }, sku: "LS-SAND-M", price: "79.00" },
    { id: `${id}-2`, options: { Color: "Navy", Size: "M" }, sku: "LS-NAVY-M", price: "79.00", compareAtPrice: "99.00" },
  ],
  ...extra,
});

describe("products", () => {
  it("is opt-in", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), { products: [shirt("gid://shopify/Product/1")] });
    const eu = new FakeShop(FakeShop.config("eu"), {});
    const plan = await engineFor(dev, eu).plan("dev", "eu", {});
    expect(plan.ops.some((o) => o.kind === "products")).toBe(false);
  });

  it("creates new products as drafts, with variants, SKUs and images, but not prices", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      files: [{ id: "gid://shopify/MediaImage/1", url: `${cdn}/linen-shirt.jpg?v=1`, alt: "Linen shirt, front" }],
      products: [shirt("gid://shopify/Product/1", { media: ["gid://shopify/MediaImage/1"] })],
    });
    const eu = new FakeShop(FakeShop.config("eu"), {});
    const engine = engineFor(dev, eu);
    const plan = await engine.plan("dev", "eu", { resources: ["products"] });

    expect(plan.ops.map((o) => `${o.action} ${o.key}`)).toEqual(["create linen-shirt"]);
    expect(plan.warnings.join("\n")).toMatch(/1 new product\(s\) will be created as drafts/);
    expect(plan.warnings.join("\n")).toMatch(/Prices are not copied/);
    expect(plan.warnings.join("\n")).toMatch(/1 file\(s\) don't exist in the target and will be uploaded/);

    const { results } = await engine.apply(plan.id);
    expect(results.map((r) => `${r.outcome} ${r.key}`)).toEqual(["created linen-shirt"]);
    const p = eu.state.products.find((x) => x.handle === "linen-shirt")!;
    expect(p.status).toBe("DRAFT");
    expect(p.title).toBe("Linen shirt");
    expect(p.tags).toEqual(["linen", "summer"]);
    expect(p.options).toEqual([
      { name: "Color", values: ["Sand", "Navy"] },
      { name: "Size", values: ["M"] },
    ]);
    expect(p.variants!.map((v) => [v.sku, v.price])).toEqual([
      ["LS-SAND-M", "0.00"],
      ["LS-NAVY-M", "0.00"],
    ]);
    expect(p.media).toHaveLength(1);
    expect(eu.state.files.find((f) => f.id === p.media![0])!.url).toContain("linen-shirt.jpg");

    // A second plan finds nothing left to do.
    expect((await engine.plan("dev", "eu", { resources: ["products"] })).ops).toEqual([]);
  });

  it("copies prices only when asked", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), { products: [shirt("gid://shopify/Product/1")] });
    const eu = new FakeShop(FakeShop.config("eu"), {});
    const engine = engineFor(dev, eu);
    const plan = await engine.plan("dev", "eu", { resources: ["products"], prices: true });
    expect(plan.warnings.join("\n")).not.toMatch(/Prices are not copied/);
    await engine.apply(plan.id);
    const p = eu.state.products.find((x) => x.handle === "linen-shirt")!;
    expect(p.variants!.map((v) => [v.price, v.compareAtPrice])).toEqual([
      ["79.00", null],
      ["79.00", "99.00"],
    ]);
  });

  it("updates without deleting the target's own variants or images, and keeps its prices", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      products: [shirt("gid://shopify/Product/1", { title: "Linen shirt, relaxed fit", options: [{ name: "Color", values: ["Sand", "Navy", "Olive"] }, { name: "Size", values: ["M"] }], variants: [
        { id: "a", options: { Color: "Sand", Size: "M" }, sku: "LS-SAND-M", price: "79.00" },
        { id: "b", options: { Color: "Navy", Size: "M" }, sku: "LS-NAVY-M", price: "79.00" },
        { id: "c", options: { Color: "Olive", Size: "M" }, sku: "LS-OLIVE-M", price: "79.00" },
      ] })],
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      files: [{ id: "gid://shopify/MediaImage/900", url: `${cdn}/eu-only.jpg?v=1` }],
      products: [
        shirt("gid://shopify/Product/9", {
          options: [{ name: "Color", values: ["Sand", "Navy", "Black"] }, { name: "Size", values: ["M"] }],
          variants: [
            { id: "eu-1", options: { Color: "Sand", Size: "M" }, sku: "LS-SAND-M", price: "89.00" },
            { id: "eu-2", options: { Color: "Navy", Size: "M" }, sku: "LS-NAVY-M", price: "89.00" },
            { id: "eu-3", options: { Color: "Black", Size: "M" }, sku: "LS-BLACK-M", price: "89.00" },
          ],
          media: ["gid://shopify/MediaImage/900"],
        }),
      ],
    });
    const engine = engineFor(dev, eu);
    const plan = await engine.plan("dev", "eu", { resources: ["products"] });
    expect(plan.ops.map((o) => `${o.action} ${o.key}`)).toEqual(["update linen-shirt"]);
    expect(plan.ops[0]!.changes!.map((c) => c.path)).toEqual([
      "images",
      "options[0].values[2]",
      "title",
      "variants[2].options.Color",
      "variants[2].sku",
    ]);
    const { results } = await engine.apply(plan.id);
    expect(results.map((r) => r.outcome)).toEqual(["updated"]);

    const p = eu.state.products.find((x) => x.handle === "linen-shirt")!;
    expect(p.title).toBe("Linen shirt, relaxed fit");
    expect(p.status).toBe(undefined); // existing product's status untouched
    expect(p.variants!.map((v) => `${v.id ?? ""}:${v.options.Color}:${v.price}`)).toEqual([
      "eu-1:Sand:89.00",
      "eu-2:Navy:89.00",
      expect.stringMatching(/:Olive:0\.00$/),
      "eu-3:Black:89.00",
    ]);
    expect(p.options![0]!.values).toEqual(["Sand", "Navy", "Olive", "Black"]);
    expect(p.media).toEqual(["gid://shopify/MediaImage/900"]);
  });

  it("reports products whose options are named differently as a conflict", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), { products: [shirt("gid://shopify/Product/1")] });
    const eu = new FakeShop(FakeShop.config("eu"), {
      products: [shirt("gid://shopify/Product/9", { options: [{ name: "Colour", values: ["Sand"] }, { name: "Size", values: ["M"] }], variants: [{ id: "x", options: { Colour: "Sand", Size: "M" } }] })],
    });
    const plan = await engineFor(dev, eu).plan("dev", "eu", { resources: ["products"] });
    expect(plan.ops[0]!.action).toBe("conflict");
    expect(plan.ops[0]!.reason).toMatch(/options differ \(Colour, Size in target, Color, Size in source\)/);
  });

  it("skips gift cards", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), { products: [{ id: "gid://shopify/Product/5", handle: "gift-card", isGiftCard: true }] });
    const eu = new FakeShop(FakeShop.config("eu"), {});
    const plan = await engineFor(dev, eu).plan("dev", "eu", { resources: ["products"] });
    expect(plan.ops).toEqual([]);
    expect(plan.skipped).toEqual([{ kind: "products", key: "gift-card", reason: "gift card" }]);
  });

  it("lets other items in the same plan point at a product it creates", async () => {
    const def = (id: string) => ({
      id,
      type: "lookbook",
      name: "Lookbook",
      description: null,
      displayNameKey: null,
      access: { storefront: "PUBLIC_READ", customerAccount: "NONE" },
      capabilities: { publishable: { enabled: false }, translatable: { enabled: false }, renderable: { enabled: false }, onlineStore: { enabled: false, data: null } },
      fieldDefinitions: [{ key: "product", name: "Product", description: null, required: false, type: { name: "product_reference" }, validations: [], capabilities: { adminFilterable: { enabled: false } } }],
    });
    const dev = new FakeShop(FakeShop.config("dev"), {
      products: [shirt("gid://shopify/Product/1")],
      metaobjectDefinitions: [def("gid://shopify/MetaobjectDefinition/1")],
      metaobjects: [{ id: "gid://shopify/Metaobject/1", type: "lookbook", handle: "summer", fields: [{ key: "product", value: "gid://shopify/Product/1" }], capabilities: { publishable: null } }],
    } as any);
    const eu = new FakeShop(FakeShop.config("eu"), { metaobjectDefinitions: [def("gid://shopify/MetaobjectDefinition/9")] } as any);
    const engine = engineFor(dev, eu);
    const plan = await engine.plan("dev", "eu", { resources: ["products", "metaobjects"] });
    expect(plan.ops.map((o) => `${o.kind} ${o.key}`)).toEqual(["products linen-shirt", "metaobjects lookbook/summer"]);
    expect(plan.ops[1]!.missingRefs).toBeUndefined();
    await engine.apply(plan.id);
    const created = eu.state.products.find((x) => x.handle === "linen-shirt")!;
    expect(eu.state.metaobjects[0]!.fields).toEqual([{ key: "product", value: created.id }]);
  });

  it("checks for drift with the same read options the plan used", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), { products: [shirt("gid://shopify/Product/1", { title: "New title" })] });
    const eu = new FakeShop(FakeShop.config("eu"), { products: [shirt("gid://shopify/Product/9")] });
    const engine = engineFor(dev, eu);
    const plan = await engine.plan("dev", "eu", { resources: ["products"], prices: true });
    const { results } = await engine.apply(plan.id);
    expect(results.map((r) => r.outcome)).toEqual(["updated"]);
  });
});
