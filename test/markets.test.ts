import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StoreRegistry, type StoreConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { PlanStore } from "../src/plan.js";
import { FakeShop, type FakeProduct } from "./fakeShop.js";

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

const product = (id: string, handle: string, extra: Partial<FakeProduct> = {}): FakeProduct => ({
  id,
  handle,
  variants: [{ id: `${id}-v1`, options: { Size: "S" }, price: "10.00" }],
  options: [{ name: "Size", values: ["S"] }],
  ...extra,
});

describe("locations", () => {
  it("creates missing locations and edits addresses, leaving fulfillment-app locations alone", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      locations: [
        { id: "gid://shopify/Location/1", name: "Warehouse", address: { address1: "1 Rue A", city: "Casablanca", countryCode: "MA", zip: "20000" }, fulfillsOnlineOrders: true },
        { id: "gid://shopify/Location/2", name: "Showroom", address: { city: "Rabat", countryCode: "MA" }, fulfillsOnlineOrders: false },
        { id: "gid://shopify/Location/3", name: "3PL", isFulfillmentService: true },
      ],
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      locations: [{ id: "gid://shopify/Location/91", name: "Warehouse", address: { address1: "old", city: "Casablanca", countryCode: "MA" } }],
    });
    const engine = engineFor(dev, eu);
    const { plan, results } = await sync(engine, "dev", "eu", ["locations"]);

    expect(plan.ops.map((o) => `${o.action} ${o.key}`)).toEqual(["create Showroom", "update Warehouse"]);
    expect(plan.skipped).toEqual([{ kind: "locations", key: "3PL", reason: "run by a fulfillment app" }]);
    expect(results.every((r) => r.outcome !== "failed")).toBe(true);
    expect(eu.state.locations.find((l) => l.name === "Warehouse")!.address).toMatchObject({ address1: "1 Rue A", zip: "20000" });
    expect(eu.state.locations.find((l) => l.name === "Showroom")).toMatchObject({ fulfillsOnlineOrders: false, address: { city: "Rabat", countryCode: "MA" } });
    expect((await engine.plan("dev", "eu", { resources: ["locations"] })).ops).toEqual([]);
  });
});

describe("markets", () => {
  it("creates country markets with currency, inclusions and subfolders, and only adds countries to existing ones", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      webPresences: [{ id: "gid://shopify/MarketWebPresence/1", subfolderSuffix: "fr", defaultLocale: "fr", alternateLocales: ["en"] }],
      markets: [
        {
          id: "gid://shopify/Market/1",
          handle: "europe",
          name: "Europe",
          regions: ["FR", "DE", "ES"],
          currency: { baseCurrency: "EUR", localCurrencies: true, roundingEnabled: true },
          priceInclusions: { duties: "ADD_DUTIES_AT_CHECKOUT", taxes: "INCLUDES_TAXES_IN_PRICE" },
          webPresenceIds: ["gid://shopify/MarketWebPresence/1"],
        },
        { id: "gid://shopify/Market/2", handle: "us", name: "United States", regions: ["US"] },
        { id: "gid://shopify/Market/3", handle: "b2b", name: "Wholesale", type: "COMPANY_LOCATION", regions: [] },
      ],
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      markets: [{ id: "gid://shopify/Market/91", handle: "us", name: "USA", regions: ["US", "PR"] }],
    });
    const engine = engineFor(dev, eu);
    const { plan, results } = await sync(engine, "dev", "eu", ["markets"]);

    expect(plan.ops.map((o) => `${o.action} ${o.key}`)).toEqual(["create europe", "update us"]);
    expect(plan.skipped.map((s) => s.key)).toEqual(["b2b"]);
    expect(results.filter((r) => r.outcome === "failed")).toEqual([]);
    const europe = eu.state.markets.find((m) => m.handle === "europe")!;
    expect(europe).toMatchObject({ name: "Europe", regions: ["DE", "ES", "FR"], currency: { baseCurrency: "EUR", localCurrencies: true, roundingEnabled: true } });
    expect(europe.priceInclusions).toEqual({ duties: "ADD_DUTIES_AT_CHECKOUT", taxes: "INCLUDES_TAXES_IN_PRICE" });
    expect(eu.state.webPresences.map((w) => w.subfolderSuffix)).toEqual(["fr"]);
    // The country only the target has (PR) is kept.
    expect(eu.state.markets.find((m) => m.handle === "us")).toMatchObject({ name: "United States", regions: ["US", "PR"] });
    expect((await engine.plan("dev", "eu", { resources: ["markets"] })).ops).toEqual([]);
  });

  it("reports a domain web presence it can't create", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      webPresences: [{ id: "gid://shopify/MarketWebPresence/1", domain: "shop.example.de", defaultLocale: "de" }],
      markets: [{ id: "gid://shopify/Market/1", handle: "de", name: "Germany", regions: ["DE"], webPresenceIds: ["gid://shopify/MarketWebPresence/1"] }],
    });
    const eu = new FakeShop(FakeShop.config("eu"));
    const { results } = await sync(engineFor(dev, eu), "dev", "eu", ["markets"]);
    expect(results[0]).toMatchObject({ outcome: "failed" });
    expect(results[0]!.message).toMatch(/shop\.example\.de aren't connected/);
    expect(eu.state.markets.map((m) => m.handle)).toEqual(["de"]);
  });
});

describe("catalogs", () => {
  it("creates a market catalog with its price list and fixed prices, after the market it needs", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      products: [product("gid://shopify/Product/1", "tee")],
      markets: [{ id: "gid://shopify/Market/1", handle: "europe", name: "Europe", regions: ["FR"] }],
      catalogs: [{ id: "gid://shopify/MarketCatalog/1", title: "Europe prices", status: "ACTIVE", marketIds: ["gid://shopify/Market/1"], priceListId: "gid://shopify/PriceList/1", publicationId: "gid://shopify/Publication/7" }],
      priceLists: [
        {
          id: "gid://shopify/PriceList/1",
          name: "Europe prices",
          currency: "EUR",
          adjustment: { type: "PERCENTAGE_INCREASE", value: 10 },
          compareAtMode: "NULLIFY",
          fixed: [{ variantId: "gid://shopify/Product/1-v1", price: "12.50" }],
        },
      ],
      publications: [{ id: "gid://shopify/Publication/7", catalogId: "gid://shopify/MarketCatalog/1", autoPublish: true }],
    });
    const eu = new FakeShop(FakeShop.config("eu"), { products: [product("gid://shopify/Product/91", "tee")] });
    const engine = engineFor(dev, eu);
    const { plan, results } = await sync(engine, "dev", "eu", ["markets", "catalogs"], { prices: true });

    expect(plan.ops.map((o) => `${o.kind} ${o.action} ${o.key}`)).toEqual(["markets create europe", "catalogs create Europe prices"]);
    expect(plan.warnings).toEqual([
      "New catalog(s) Europe prices will start with no products, so their markets won't sell anything until products are added; include sales_channels to copy which products they include.",
    ]);
    expect(results.filter((r) => r.outcome === "failed")).toEqual([]);
    const cat = eu.state.catalogs[0]!;
    expect(cat.marketIds).toEqual([eu.state.markets[0]!.id]);
    const pl = eu.state.priceLists.find((p) => p.id === cat.priceListId)!;
    expect(pl).toMatchObject({ currency: "EUR", adjustment: { type: "PERCENTAGE_INCREASE", value: 10 }, compareAtMode: "NULLIFY" });
    expect(pl.fixed).toEqual([{ variantId: "gid://shopify/Product/91-v1", price: "12.5", compareAtPrice: undefined }]);
    expect(eu.state.publications.find((p) => p.id === cat.publicationId)).toMatchObject({ autoPublish: true });
    expect((await engine.plan("dev", "eu", { resources: ["markets", "catalogs"], prices: true })).ops).toEqual([]);
  });

  it("keeps markets only the target catalog has and updates its price list", async () => {
    const markets = [
      { id: "gid://shopify/Market/1", handle: "fr", name: "France", regions: ["FR"] },
      { id: "gid://shopify/Market/2", handle: "be", name: "Belgium", regions: ["BE"] },
    ];
    const pl = (id: string, value: number) => ({ id, name: "EU", currency: "EUR", adjustment: { type: "PERCENTAGE_DECREASE", value }, compareAtMode: "ADJUSTED", fixed: [] });
    const dev = new FakeShop(FakeShop.config("dev"), {
      markets: [markets[0]!],
      catalogs: [{ id: "gid://shopify/MarketCatalog/1", title: "EU", status: "ACTIVE", marketIds: ["gid://shopify/Market/1"], priceListId: "gid://shopify/PriceList/1" }],
      priceLists: [pl("gid://shopify/PriceList/1", 15)],
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      markets: markets.map((m) => ({ ...m, id: m.id.replace("Market/", "Market/9") })),
      catalogs: [{ id: "gid://shopify/MarketCatalog/91", title: "EU", status: "DRAFT", marketIds: ["gid://shopify/Market/92"], priceListId: "gid://shopify/PriceList/91" }],
      priceLists: [pl("gid://shopify/PriceList/91", 5)],
    });
    const engine = engineFor(dev, eu);
    const { results } = await sync(engine, "dev", "eu", ["catalogs"]);
    expect(results.map((r) => r.outcome)).toEqual(["updated"]);
    expect(eu.state.catalogs[0]).toMatchObject({ status: "ACTIVE", marketIds: ["gid://shopify/Market/91", "gid://shopify/Market/92"] });
    expect(eu.state.priceLists[0]!.adjustment.value).toBe(15);
  });
});

describe("currencies", () => {
  const madStore = (extra = {}) =>
    new FakeShop(FakeShop.config("dev"), {
      currencyCode: "MAD",
      products: [product("gid://shopify/Product/1", "tee")],
      markets: [{ id: "gid://shopify/Market/1", handle: "de", name: "Germany", regions: ["DE"], currency: { baseCurrency: "MAD", localCurrencies: false, roundingEnabled: true } }],
      catalogs: [{ id: "gid://shopify/MarketCatalog/1", title: "DE", status: "ACTIVE", marketIds: ["gid://shopify/Market/1"], priceListId: "gid://shopify/PriceList/1" }],
      priceLists: [{ id: "gid://shopify/PriceList/1", name: "DE", currency: "MAD", adjustment: { type: "PERCENTAGE_INCREASE", value: 10 }, compareAtMode: "ADJUSTED", fixed: [{ variantId: "gid://shopify/Product/1-v1", price: "990.00" }] }],
      ...extra,
    });
  const eurStore = () =>
    new FakeShop(FakeShop.config("eu"), {
      currencyCode: "EUR",
      products: [product("gid://shopify/Product/91", "tee", { variants: [{ id: "gid://shopify/Product/91-v1", options: { Size: "S" }, price: "5.00" }] })],
      markets: [{ id: "gid://shopify/Market/91", handle: "de", name: "Germany", regions: ["DE"] }],
    });

  it("refuses fixed prices in a currency the target doesn't sell in without a rate, and leaves product prices out", async () => {
    const eu = eurStore();
    const engine = engineFor(madStore(), eu);
    const plan = await engine.plan("dev", "eu", { resources: ["products", "markets", "catalogs"], prices: true });
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Product prices left out: dev sells in MAD, eu in EUR; pass currency_rates \{"MAD:EUR": <rate>\}/),
        expect.stringMatching(/^Catalog DE: its fixed prices are in MAD, which eu doesn't sell in/),
        expect.stringMatching(/^Market de: its currency MAD isn't sold in eu/),
      ]),
    );
    expect(plan.ops.find((o) => o.kind === "products")).toBeUndefined();
    const { results } = await engine.apply(plan.id);
    expect(results.find((r) => r.key === "DE")!.message).toMatch(/in MAD, which the target doesn't sell in \(store currency EUR\).*Nothing was written/);
    expect(eu.state.catalogs).toEqual([]);
    expect(eu.state.products[0]!.variants![0]!.price).toBe("5.00");
  });

  it("converts prices, fixed prices and market currencies with the rate given", async () => {
    const eu = eurStore();
    const engine = engineFor(madStore(), eu);
    const scope = { resources: ["products", "markets", "catalogs"] as any, prices: true, currencyRates: { "EUR:MAD": 10 } };
    const plan = await engine.plan("dev", "eu", scope);
    expect(plan.warnings).toEqual(expect.arrayContaining(["Product prices converted from MAD to EUR at 0.1, rounded to 2 decimals.", "Catalog DE: price list moved from MAD to EUR, fixed prices converted at 0.1."]));
    const { results } = await engine.apply(plan.id);
    expect(results.filter((r) => r.outcome === "failed")).toEqual([]);
    expect(eu.state.products[0]!.variants![0]!.price).toBe("1.00");
    const pl = eu.state.priceLists[0]!;
    expect(pl).toMatchObject({ currency: "EUR", fixed: [{ variantId: "gid://shopify/Product/91-v1", price: "99.00" }] });
    expect(eu.state.markets[0]!.currency).toMatchObject({ baseCurrency: "EUR" });
    expect((await engine.plan("dev", "eu", scope)).ops).toEqual([]);
  });
});

describe("sales_channels", () => {
  const channels = (ids: [string, string][]) => ids.map(([id, app]) => ({ id, app, autoPublish: false }));

  it("publishes products and collections on the same channels and copies product status, never unpublishing", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      products: [product("gid://shopify/Product/1", "tee", { status: "ACTIVE" }), product("gid://shopify/Product/2", "cap", { status: "DRAFT" })],
      collections: [{ id: "gid://shopify/Collection/1", handle: "summer" }],
      publications: channels([
        ["gid://shopify/Publication/1", "online_store"],
        ["gid://shopify/Publication/2", "pos"],
      ]),
      published: {
        "gid://shopify/Product/1": ["gid://shopify/Publication/1", "gid://shopify/Publication/2"],
        "gid://shopify/Collection/1": ["gid://shopify/Publication/1"],
      },
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      products: [product("gid://shopify/Product/91", "tee", { status: "DRAFT" }), product("gid://shopify/Product/92", "cap", { status: "DRAFT" })],
      collections: [{ id: "gid://shopify/Collection/91", handle: "summer" }],
      publications: channels([
        ["gid://shopify/Publication/91", "online_store"],
        ["gid://shopify/Publication/92", "pos"],
        ["gid://shopify/Publication/93", "shop"],
      ]),
      published: { "gid://shopify/Product/91": ["gid://shopify/Publication/93"] },
    });
    const engine = engineFor(dev, eu);
    const { plan, results } = await sync(engine, "dev", "eu", ["sales_channels"]);

    expect(plan.ops.map((o) => `${o.action} ${o.key}`)).toEqual(["update Collection/summer", "update Product/tee"]);
    expect(results.filter((r) => r.outcome === "failed")).toEqual([]);
    expect(eu.state.published["gid://shopify/Product/91"]!.sort()).toEqual(["gid://shopify/Publication/91", "gid://shopify/Publication/92", "gid://shopify/Publication/93"]);
    expect(eu.state.products[0]!.status).toBe("ACTIVE");
    expect(eu.state.published["gid://shopify/Collection/91"]).toEqual(["gid://shopify/Publication/91"]);
    expect((await engine.plan("dev", "eu", { resources: ["sales_channels"] })).ops).toEqual([]);
  });

  it("publishes on the channels the target has and reports the missing one", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      products: [product("gid://shopify/Product/1", "tee")],
      publications: channels([
        ["gid://shopify/Publication/1", "online_store"],
        ["gid://shopify/Publication/2", "google"],
      ]),
      published: { "gid://shopify/Product/1": ["gid://shopify/Publication/1", "gid://shopify/Publication/2"] },
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      products: [product("gid://shopify/Product/91", "tee")],
      publications: channels([["gid://shopify/Publication/91", "online_store"]]),
    });
    const { plan, results } = await sync(engineFor(dev, eu), "dev", "eu", ["sales_channels"]);
    expect(plan.warnings).toEqual(["1 item(s) are on google, which eu doesn't have (install that sales channel there); they will be published on their other channels and reported as failed."]);
    expect(results[0]).toMatchObject({ outcome: "failed" });
    expect(results[0]!.message).toMatch(/not published on google.*published on online_store/);
    expect(eu.state.published["gid://shopify/Product/91"]).toEqual(["gid://shopify/Publication/91"]);
  });

  it("reads only the products the include patterns name, and reports products missing from the target as conflicts", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      products: [product("gid://shopify/Product/1", "linen-tee"), product("gid://shopify/Product/2", "linen-cap"), product("gid://shopify/Product/3", "wool-hat")],
      publications: channels([["gid://shopify/Publication/1", "online_store"]]),
      published: { "gid://shopify/Product/1": ["gid://shopify/Publication/1"], "gid://shopify/Product/2": ["gid://shopify/Publication/1"], "gid://shopify/Product/3": ["gid://shopify/Publication/1"] },
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      products: [product("gid://shopify/Product/91", "linen-tee")],
      publications: channels([["gid://shopify/Publication/91", "online_store"]]),
    });
    const engine = engineFor(dev, eu);
    const plan = await engine.plan("dev", "eu", { resources: ["sales_channels"], include: ["Product/linen-*"] });
    expect(plan.ops.map((o) => `${o.action} ${o.key}`)).toEqual(["conflict Product/linen-cap", "update Product/linen-tee"]);
    expect(dev.calls.filter((c) => c.field === "products").map((c) => c.variables.query)).toEqual(["handle:linen-*"]);
    expect(dev.calls.some((c) => c.field === "collections")).toBe(false);
  });

  it("includes products in a market catalog created by the same plan", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      products: [product("gid://shopify/Product/1", "tee")],
      markets: [{ id: "gid://shopify/Market/1", handle: "fr", name: "France", regions: ["FR"] }],
      catalogs: [{ id: "gid://shopify/MarketCatalog/1", title: "France", status: "ACTIVE", marketIds: ["gid://shopify/Market/1"], publicationId: "gid://shopify/Publication/7" }],
      publications: [{ id: "gid://shopify/Publication/7", catalogId: "gid://shopify/MarketCatalog/1", autoPublish: false }],
      published: { "gid://shopify/Product/1": ["gid://shopify/Publication/7"] },
    });
    const eu = new FakeShop(FakeShop.config("eu"), { products: [product("gid://shopify/Product/91", "tee")] });
    const engine = engineFor(dev, eu);
    const { results } = await sync(engine, "dev", "eu", ["markets", "catalogs", "sales_channels"]);
    expect(results.filter((r) => r.outcome === "failed")).toEqual([]);
    const pub = eu.state.catalogs[0]!.publicationId!;
    expect(eu.state.published["gid://shopify/Product/91"]).toEqual([pub]);
    expect((await engine.plan("dev", "eu", { resources: ["markets", "catalogs", "sales_channels"] })).ops).toEqual([]);
  });
});

describe("sales_channels on a big catalog", () => {
  it("reads with bulk exports and writes in batches", async () => {
    const old = process.env.SYNC_BULK_THRESHOLD;
    process.env.SYNC_BULK_THRESHOLD = "2";
    const { bulkIO } = await import("../src/shopify/bulk.js");
    const { bulkFiles } = await import("./fakeShop.js");
    const io = { ...bulkIO };
    bulkIO.wait = async () => {};
    bulkIO.download = async (url) => bulkFiles.get(url) ?? "";
    try {
      const handles = ["a", "b", "c", "d", "e"];
      const dev = new FakeShop(FakeShop.config("dev"), {
        products: handles.map((h, i) => product(`gid://shopify/Product/${i + 1}`, h, { status: "ACTIVE" })),
        publications: [{ id: "gid://shopify/Publication/1", app: "online_store", autoPublish: false }],
        published: Object.fromEntries(handles.map((_, i) => [`gid://shopify/Product/${i + 1}`, ["gid://shopify/Publication/1"]])),
      });
      const eu = new FakeShop(FakeShop.config("eu"), {
        products: handles.map((h, i) => product(`gid://shopify/Product/9${i + 1}`, h, { status: "DRAFT" })),
        publications: [{ id: "gid://shopify/Publication/91", app: "online_store", autoPublish: false }],
      });
      const engine = engineFor(dev, eu);
      const { plan, results } = await sync(engine, "dev", "eu", ["sales_channels"]);
      expect(plan.ops).toHaveLength(5);
      expect(results.filter((r) => r.outcome === "failed")).toEqual([]);
      expect(dev.calls.some((c) => c.field === "bulkOperationRunQuery")).toBe(true);
      expect(eu.state.products.every((p) => p.status === "ACTIVE" && eu.state.published[p.id]?.includes("gid://shopify/Publication/91"))).toBe(true);
      expect(eu.calls.filter((c) => c.field === "publishablePublish").length).toBe(5);
      expect((await engine.plan("dev", "eu", { resources: ["sales_channels"] })).ops).toEqual([]);
    } finally {
      Object.assign(bulkIO, io);
      if (old === undefined) delete process.env.SYNC_BULK_THRESHOLD;
      else process.env.SYNC_BULK_THRESHOLD = old;
    }
  });
});

describe("market translations", () => {
  it("copies the translations a market overrides to the market of the same handle", async () => {
    const content = { "gid://shopify/Page/1": [{ key: "title", digest: "d1" }], "gid://shopify/Page/91": [{ key: "title", digest: "d91" }] };
    const dev = new FakeShop(FakeShop.config("dev"), {
      shopLocales: [{ locale: "en", primary: true }, { locale: "fr", primary: false }],
      pages: [{ id: "gid://shopify/Page/1", handle: "shipping", title: "Shipping" }],
      markets: [{ id: "gid://shopify/Market/1", handle: "canada", name: "Canada", regions: ["CA"] }],
      translations: { "gid://shopify/Page/1": { fr: { title: "Livraison" } } },
      marketTranslations: { "gid://shopify/Page/1": { "gid://shopify/Market/1": { fr: { title: "Expédition" } } } },
      translatableContent: content,
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      shopLocales: [{ locale: "en", primary: true }, { locale: "fr", primary: false }],
      pages: [{ id: "gid://shopify/Page/91", handle: "shipping", title: "Shipping" }],
      markets: [{ id: "gid://shopify/Market/91", handle: "canada", name: "Canada", regions: ["CA"] }],
      translatableContent: content,
    });
    const engine = engineFor(dev, eu);
    const { plan, results } = await sync(engine, "dev", "eu", ["translations"], { marketTranslations: true });
    expect(plan.ops.map((o) => o.key)).toEqual(["fr:Page/shipping", "fr@canada:Page/shipping"]);
    expect(results.filter((r) => r.outcome === "failed")).toEqual([]);
    expect(eu.state.translations["gid://shopify/Page/91"]).toEqual({ fr: { title: "Livraison" } });
    expect(eu.state.marketTranslations["gid://shopify/Page/91"]).toEqual({ "gid://shopify/Market/91": { fr: { title: "Expédition" } } });
    // Without the option, only the shop-wide translation is read.
    expect((await engine.plan("dev", "eu", { resources: ["translations"] })).ops).toEqual([]);
  });
});
