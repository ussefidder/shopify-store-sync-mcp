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
    // The target's own image and its Black variant aren't differences: they're kept.
    expect(plan.ops[0]!.changes!.map((c) => c.path)).toEqual(["options[Color].values[2]", "title", "variants"]);
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

    // What the target keeps on its own isn't a difference: the next plan has nothing to do.
    expect((await engine.plan("dev", "eu", { resources: ["products"] })).ops).toEqual([]);
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

describe("large catalogs", () => {
  const tee = (n: number): FakeProduct => ({ id: `gid://shopify/Product/9${n}`, handle: `tee-${n}`, title: `Tee ${n}` });

  it("reads in full only the target products the source also has; the rest is listed by handle", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), { products: [shirt("gid://shopify/Product/1")] });
    const stg = new FakeShop(FakeShop.config("stg"), {
      products: [shirt("gid://shopify/Product/2", { title: "Linen shirt v2" }), ...Array.from({ length: 30 }, (_, i) => tee(i))],
    });
    const { diffs } = await engineFor(dev, stg).compare("dev", "stg", { resources: ["products"] });

    const d = diffs[0]!;
    expect(d.changed.map((c) => c.key)).toEqual(["linen-shirt"]);
    expect(d.onlyInTarget.length).toBe(30);
    // The target was listed, then one product looked up; never paged through in full.
    const full = stg.calls.filter((c) => c.field === "productByIdentifier").map((c) => c.variables.handle);
    expect(full).toEqual(["linen-shirt"]);
  });

  it("uses image URLs from the product read instead of looking each image up", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      files: [{ id: "gid://shopify/MediaImage/1", url: `${cdn}/linen-shirt.jpg?v=1` }],
      products: [shirt("gid://shopify/Product/1", { media: ["gid://shopify/MediaImage/1"] })],
    });
    const snap = await engineFor(dev).load("dev", { resources: ["products"] });
    expect(snap.resources.products!.items[0]!.data.images).toEqual([{ file: "shopify://File/linen-shirt.jpg" }]);
    expect(dev.calls.some((c) => c.field === "nodes")).toBe(false);
  });
});

describe("product page details", () => {
  const files = [
    { id: "gid://shopify/MediaImage/1", url: `${cdn}/sand.jpg?v=1` },
    { id: "gid://shopify/MediaImage/2", url: `${cdn}/navy.jpg?v=1` },
  ];
  const detailed = (id: string) =>
    shirt(id, {
      media: ["gid://shopify/MediaImage/1", "gid://shopify/MediaImage/2"],
      variants: [
        { id: `${id}-1`, options: { Color: "Sand", Size: "M" }, sku: "LS-SAND-M", barcode: "3600000000017", image: "gid://shopify/MediaImage/1", weight: { value: 0.3, unit: "KILOGRAMS" }, harmonizedSystemCode: "620520", countryCodeOfOrigin: "PT", stock: { Paris: 7 } },
        { id: `${id}-2`, options: { Color: "Navy", Size: "M" }, sku: "LS-NAVY-M", barcode: "3600000000024", image: "gid://shopify/MediaImage/2", requiresShipping: true, stock: { Paris: 2, Lyon: 4 } },
      ],
    });

  it("copies barcodes, weight, customs details and variant images; stock only when asked", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), { files: [...files], products: [detailed("gid://shopify/Product/1")] });
    const eu = new FakeShop(FakeShop.config("eu"), { locations: [{ id: "gid://shopify/Location/9", name: "Paris" }] });
    const engine = engineFor(dev, eu);
    const plan = await engine.plan("dev", "eu", { resources: ["products"] });
    const v = (plan.ops[0]!.data.variants as any[])[0];
    expect(v).toMatchObject({ barcode: "3600000000017", weight: { value: 0.3, unit: "KILOGRAMS" }, harmonizedSystemCode: "620520", countryCodeOfOrigin: "PT", image: "shopify://File/sand.jpg" });
    expect(v.inventory).toBeUndefined();
    await engine.apply(plan.id);
    const p = eu.state.products[0]!;
    const sand = p.variants!.find((x) => x.options.Color === "Sand")!;
    expect(sand.barcode).toBe("3600000000017");
    expect(sand.weight).toEqual({ value: 0.3, unit: "KILOGRAMS" });
    expect(eu.state.files.find((f) => f.id === sand.image)?.url).toContain("sand.jpg");
    expect(sand.stock).toBeUndefined();
  });

  it("with inventory: stock lands in the target's location with the same name", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), { files: [...files], products: [detailed("gid://shopify/Product/1")] });
    const eu = new FakeShop(FakeShop.config("eu"), { locations: [{ id: "gid://shopify/Location/9", name: "Paris" }] });
    const engine = engineFor(dev, eu);
    const plan = await engine.plan("dev", "eu", { resources: ["products"], inventory: true });
    expect((plan.ops[0]!.data.variants as any[])[1].inventory).toEqual({ Paris: 2, Lyon: 4 });
    await engine.apply(plan.id);
    const navy = eu.state.products[0]!.variants!.find((x) => x.options.Color === "Navy")!;
    // Lyon doesn't exist in the target, so only Paris is set.
    expect(navy.stock).toEqual({ Paris: 2 });

    // Later the source sells some: an update sets the existing variant's stock, checked against what the target has now.
    dev.state.products[0]!.variants![1]!.stock = { Paris: 1, Lyon: 4 };
    const again = await engine.plan("dev", "eu", { resources: ["products"], inventory: true });
    expect(again.ops.map((o) => o.action)).toEqual(["update"]);
    await engine.apply(again.id);
    expect(eu.state.products[0]!.variants!.find((x) => x.options.Color === "Navy")!.stock).toEqual({ Paris: 1 });
  });
});

describe("large writes", () => {
  it("creates many products, their variants' metafields and images in bulk operations", async () => {
    const { bulkIO } = await import("../src/shopify/bulk.js");
    const { bulkFiles } = await import("./fakeShop.js");
    bulkIO.wait = async () => {};
    bulkIO.upload = async (_url, form) => {
      bulkFiles.set(String(form.get("key")), await (form.get("file") as Blob).text());
    };
    bulkIO.download = async (url) => bulkFiles.get(url) ?? "";
    process.env.SYNC_BULK_THRESHOLD = "2";
    process.env.SYNC_BULK_WRITES = "true";
    try {
      const files = Array.from({ length: 4 }, (_, i) => ({ id: `gid://shopify/MediaImage/${i + 1}`, url: `${cdn}/tee-${i}.jpg?v=1` }));
      const products = Array.from({ length: 4 }, (_, i) =>
        shirt(`gid://shopify/Product/${i + 1}`, {
          handle: `tee-${i}`,
          media: [files[i]!.id],
          variants: [{ id: `gid://shopify/ProductVariant/${i + 1}`, options: { Color: "Sand", Size: "M" }, image: files[i]!.id, metafields: [{ namespace: "custom", key: "fit", type: "single_line_text_field", value: `fit-${i}` }] }],
          metafields: [
            { namespace: "custom", key: "care", type: "single_line_text_field", value: `care-${i}` },
            // A file the bulk product write brings over from the source's URL, then pointed at by a value.
            { namespace: "custom", key: "chart", type: "file_reference", value: files[i]!.id },
          ],
        }),
      );
      const dev = new FakeShop(FakeShop.config("dev"), { files, products });
      const eu = new FakeShop(FakeShop.config("eu"), {});
      const engine = engineFor(dev, eu);
      const plan = await engine.plan("dev", "eu", { resources: ["products", "metafields"] });
      expect(plan.ops.filter((o) => o.action === "conflict")).toEqual([]);
      const { results } = await engine.apply(plan.id);
      expect(results.filter((r) => r.outcome !== "created")).toEqual([]);

      const fields = eu.calls.map((c) => c.field);
      expect(fields.filter((f) => f === "bulkOperationRunMutation")).toHaveLength(2);
      // Images were created once each, all in one request, before the products: none one by one.
      expect(fields.filter((f) => f === "fileCreate")).toHaveLength(1);
      expect(eu.state.files).toHaveLength(4);
      expect(eu.state.products.map((p) => p.handle).sort()).toEqual(["tee-0", "tee-1", "tee-2", "tee-3"]);
      const tee = eu.state.products.find((p) => p.handle === "tee-2")!;
      expect(eu.state.files.find((f) => f.id === tee.media![0])?.url).toContain("tee-2.jpg");
      expect(tee.variants![0]!.image).toBe(tee.media![0]);
      expect(tee.metafields).toEqual([
        { namespace: "custom", key: "care", type: "single_line_text_field", value: "care-2" },
        { namespace: "custom", key: "chart", type: "file_reference", value: tee.media![0] },
      ]);
      expect(tee.variants![0]!.metafields).toEqual([{ namespace: "custom", key: "fit", type: "single_line_text_field", value: "fit-2" }]);
    } finally {
      delete process.env.SYNC_BULK_THRESHOLD;
      delete process.env.SYNC_BULK_WRITES;
    }
  });

  it("updates many products in one bulk operation and keeps what only the target has", async () => {
    const { bulkIO } = await import("../src/shopify/bulk.js");
    const { bulkFiles } = await import("./fakeShop.js");
    bulkIO.wait = async () => {};
    bulkIO.upload = async (_url, form) => void bulkFiles.set(String(form.get("key")), await (form.get("file") as Blob).text());
    bulkIO.download = async (url) => bulkFiles.get(url) ?? "";
    process.env.SYNC_BULK_THRESHOLD = "2";
    process.env.SYNC_BULK_WRITES = "true";
    try {
      const src = Array.from({ length: 3 }, (_, i) => shirt(`gid://shopify/Product/${i + 1}`, { handle: `tee-${i}`, title: `Tee ${i} v2` }));
      const tgt = Array.from({ length: 3 }, (_, i) =>
        shirt(`gid://shopify/Product/${i + 11}`, {
          handle: `tee-${i}`,
          title: `Tee ${i}`,
          tags: ["summer", "linen", "eu-only"],
          options: [
            { name: "Color", values: ["Sand", "Navy", "Red"] },
            { name: "Size", values: ["M"] },
          ],
          variants: [
            { id: `gid://shopify/ProductVariant/${i}01`, options: { Color: "Sand", Size: "M" }, sku: "LS-SAND-M", price: "79.00" },
            { id: `gid://shopify/ProductVariant/${i}02`, options: { Color: "Navy", Size: "M" }, sku: "LS-NAVY-M", price: "79.00", compareAtPrice: "99.00" },
            { id: `gid://shopify/ProductVariant/${i}03`, options: { Color: "Red", Size: "M" }, sku: "EU-RED-M", price: "79.00" },
          ],
        }),
      );
      const dev = new FakeShop(FakeShop.config("dev"), { products: src });
      const eu = new FakeShop(FakeShop.config("eu"), { products: tgt });
      const engine = engineFor(dev, eu);
      const plan = await engine.plan("dev", "eu", { resources: ["products"] });
      expect(plan.ops.map((o) => o.action)).toEqual(["update", "update", "update"]);
      const { results } = await engine.apply(plan.id);
      expect(results.map((r) => [r.outcome, r.message])).toEqual([["updated", undefined], ["updated", undefined], ["updated", undefined]]);
      const fields = eu.calls.map((c) => c.field);
      expect(fields.filter((f) => f === "bulkOperationRunMutation")).toHaveLength(1);
      const tee = eu.state.products.find((p) => p.handle === "tee-1")!;
      expect(tee).toMatchObject({ id: "gid://shopify/Product/12", title: "Tee 1 v2" });
      expect(tee.tags).toContain("eu-only");
      expect(tee.variants!.map((v) => v.sku)).toContain("EU-RED-M");
    } finally {
      delete process.env.SYNC_BULK_THRESHOLD;
      delete process.env.SYNC_BULK_WRITES;
    }
  });

  const bulkSetup = async () => {
    const { bulkIO } = await import("../src/shopify/bulk.js");
    const { bulkFiles } = await import("./fakeShop.js");
    bulkIO.wait = async () => {};
    bulkIO.upload = async (_url, form) => void bulkFiles.set(String(form.get("key")), await (form.get("file") as Blob).text());
    bulkIO.download = async (url) => bulkFiles.get(url) ?? "";
  };
  const tees = (n: number, withFields: boolean, idBase = 0) =>
    Array.from({ length: n }, (_, i) =>
      shirt(`gid://shopify/Product/${idBase + i + 1}`, {
        handle: `tee-${i}`,
        variants: [
          {
            id: `gid://shopify/ProductVariant/${idBase + i + 1}`,
            options: { Color: "Sand", Size: "M" },
            metafields: withFields ? [{ namespace: "custom", key: "fit", type: "single_line_text_field", value: `fit-${i}` }] : [],
          },
        ],
        metafields: withFields ? [{ namespace: "custom", key: "care", type: "single_line_text_field", value: `care-${i}` }] : [],
      }),
    );

  it("finds the products and variants that many metafield values belong to with one export, not a request each", async () => {
    await bulkSetup();
    process.env.SYNC_BULK_THRESHOLD = "2";
    try {
      const dev = new FakeShop(FakeShop.config("dev"), { products: tees(6, true) });
      const eu = new FakeShop(FakeShop.config("eu"), { products: tees(6, false, 100) });
      const engine = engineFor(dev, eu);
      const plan = await engine.plan("dev", "eu", { resources: ["metafields"] });
      expect(plan.ops).toHaveLength(12);
      expect(plan.warnings).toEqual([]);
      const { results } = await engine.apply(plan.id);
      expect(results.filter((r) => r.outcome !== "created")).toEqual([]);
      expect(eu.state.products[3]!.variants![0]!.metafields).toEqual([{ namespace: "custom", key: "fit", type: "single_line_text_field", value: "fit-3" }]);
      expect(eu.calls.filter((c) => c.field === "productByIdentifier")).toEqual([]);
    } finally {
      delete process.env.SYNC_BULK_THRESHOLD;
    }
  });

  it("fails what belongs to a product it couldn't create right away, with that as the reason", async () => {
    await bulkSetup();
    process.env.SYNC_BULK_THRESHOLD = "2";
    process.env.SYNC_BULK_WRITES = "true";
    try {
      const dev = new FakeShop(FakeShop.config("dev"), { products: tees(4, true) });
      const eu = new FakeShop(FakeShop.config("eu"), {});
      const real = eu.request.bind(eu);
      eu.request = (async (q: string, v: any) =>
        /productSet/.test(q) && v?.input?.handle === "tee-1" ? { productSet: { product: null, userErrors: [{ message: "boom" }] } } : real(q, v)) as typeof eu.request;
      const engine = engineFor(dev, eu);
      const plan = await engine.plan("dev", "eu", { resources: ["products", "metafields"] });
      const { results } = await engine.apply(plan.id);
      const failed = results.filter((r) => r.outcome === "failed").map((r) => `${r.kind} ${r.key}: ${r.message}`);
      expect(failed).toEqual([
        "products tee-1: boom",
        "metafields PRODUCT/tee-1/custom.care: not written: it belongs to Product/tee-1, which this apply could not create",
        expect.stringMatching(/^metafields PRODUCTVARIANT\/tee-1\/.*: not written: it belongs to ProductVariant\/tee-1\/.*, which this apply could not create$/),
      ]);
      expect(results.filter((r) => r.outcome === "created")).toHaveLength(9);
      // Nothing of the failed product was looked up in the target afterwards.
      expect(eu.calls.filter((c) => c.field === "productByIdentifier" && c.variables.handle === "tee-1")).toEqual([]);
    } finally {
      delete process.env.SYNC_BULK_THRESHOLD;
      delete process.env.SYNC_BULK_WRITES;
    }
  });

  it("counts products as written when their bulk operation gave no result but the store has them", async () => {
    await bulkSetup();
    process.env.SYNC_BULK_THRESHOLD = "2";
    process.env.SYNC_BULK_WRITES = "true";
    try {
      const dev = new FakeShop(FakeShop.config("dev"), { products: tees(4, true) });
      const eu = new FakeShop(FakeShop.config("eu"), {});
      const real = eu.request.bind(eu);
      let lost = 0;
      // The first bulk write (the products) runs on Shopify's side, but its status never comes back as finished.
      eu.request = (async (q: string, v: any) => {
        const d = await real(q, v);
        return /BulkStatus/.test(q) && lost++ === 0 ? { node: { status: "FAILED", errorCode: "INTERNAL_SERVER_ERROR", objectCount: "0", url: null, partialDataUrl: null } } : d;
      }) as typeof eu.request;
      const engine = engineFor(dev, eu);
      const plan = await engine.plan("dev", "eu", { resources: ["products", "metafields"] });
      const { results } = await engine.apply(plan.id);
      expect(results.filter((r) => r.outcome !== "created")).toEqual([]);
      expect(eu.state.products).toHaveLength(4);
      expect(eu.state.products[2]!.variants![0]!.metafields).toEqual([{ namespace: "custom", key: "fit", type: "single_line_text_field", value: "fit-2" }]);
    } finally {
      delete process.env.SYNC_BULK_THRESHOLD;
      delete process.env.SYNC_BULK_WRITES;
    }
  });

  it("writes many products and metafield values a few per request, several requests at once", async () => {
    await bulkSetup();
    process.env.SYNC_BULK_THRESHOLD = "2";
    try {
      const dev = new FakeShop(FakeShop.config("dev"), { products: tees(12, true) });
      const eu = new FakeShop(FakeShop.config("eu"), {});
      const engine = engineFor(dev, eu);
      const plan = await engine.plan("dev", "eu", { resources: ["products", "metafields"] });
      const { results } = await engine.apply(plan.id);
      expect(results.filter((r) => r.outcome !== "created")).toEqual([]);
      const fields = eu.calls.map((c) => c.field);
      expect(fields).not.toContain("bulkOperationRunMutation");
      // 12 products, 5 per request; 24 values, 25 per call.
      expect(fields.filter((f) => f === "Batch")).toHaveLength(4);
      expect(eu.state.products).toHaveLength(12);
      const tee = eu.state.products.find((p) => p.handle === "tee-7")!;
      expect(tee.metafields).toEqual([{ namespace: "custom", key: "care", type: "single_line_text_field", value: "care-7" }]);
      expect(tee.variants![0]!.metafields).toEqual([{ namespace: "custom", key: "fit", type: "single_line_text_field", value: "fit-7" }]);
    } finally {
      delete process.env.SYNC_BULK_THRESHOLD;
    }
  });

  it("checks the store for products of a request that failed after it may have been saved", async () => {
    await bulkSetup();
    process.env.SYNC_BULK_THRESHOLD = "2";
    try {
      const dev = new FakeShop(FakeShop.config("dev"), { products: tees(4, false) });
      const eu = new FakeShop(FakeShop.config("eu"), {});
      const real = eu.request.bind(eu);
      let lost = 0;
      eu.request = (async (q: string, v: any) => {
        const d = await real(q, v);
        if (/mutation Batch/.test(q) && q.includes("productSet") && lost++ === 0) throw new Error("Shopify CLI gave no answer and was stopped");
        return d;
      }) as typeof eu.request;
      const engine = engineFor(dev, eu);
      const plan = await engine.plan("dev", "eu", { resources: ["products"] });
      const { results } = await engine.apply(plan.id);
      expect(results.map((r) => r.outcome)).toEqual(["created", "created", "created", "created"]);
      // A create isn't sent a second time.
      expect(eu.calls.filter((c) => c.field === "Batch")).toHaveLength(1);
    } finally {
      delete process.env.SYNC_BULK_THRESHOLD;
    }
  });

  it("creates an image several new products share only once", async () => {
    const { bulkIO } = await import("../src/shopify/bulk.js");
    const { bulkFiles } = await import("./fakeShop.js");
    bulkIO.wait = async () => {};
    bulkIO.upload = async (_url, form) => void bulkFiles.set(String(form.get("key")), await (form.get("file") as Blob).text());
    bulkIO.download = async (url) => bulkFiles.get(url) ?? "";
    process.env.SYNC_BULK_THRESHOLD = "2";
    try {
      const shared = { id: "gid://shopify/MediaImage/9", url: `${cdn}/size-guide.jpg?v=1`, alt: "Size guide" };
      const products = Array.from({ length: 3 }, (_, i) => shirt(`gid://shopify/Product/${i + 1}`, { handle: `tee-${i}`, media: [shared.id] }));
      const dev = new FakeShop(FakeShop.config("dev"), { files: [shared], products });
      const eu = new FakeShop(FakeShop.config("eu"), {});
      const engine = engineFor(dev, eu);
      const plan = await engine.plan("dev", "eu", { resources: ["products"] });
      const { results } = await engine.apply(plan.id);
      expect(results.filter((r) => r.outcome !== "created")).toEqual([]);
      expect(eu.state.files).toHaveLength(1);
      expect(eu.state.files[0]).toMatchObject({ alt: "Size guide" });
      expect(new Set(eu.state.products.map((p) => p.media![0]))).toEqual(new Set([eu.state.files[0]!.id]));
    } finally {
      delete process.env.SYNC_BULK_THRESHOLD;
    }
  });
});
