import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StoreRegistry, type StoreConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { PlanStore } from "../src/plan.js";
import { FakeShop } from "./fakeShop.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function engineFor(...shops: FakeShop[]) {
  process.env.SYNC_AUDIT_LOG = join(tmp("audit-"), "audit.log");
  const byAlias = Object.fromEntries(shops.map((s) => [s.store.alias, s]));
  return new Engine(new StoreRegistry(shops.map((s) => s.store)), new PlanStore(tmp("plans-")), (s: StoreConfig) => byAlias[s.alias]!);
}

const condSource = (id: string, inclusion: unknown[], exclusion: unknown[], matchType: string | null = null) => ({
  __typename: "CollectionConditionsSource",
  id,
  title: "Untitled Source",
  inclusion: { matchType, conditions: inclusion },
  exclusion: { matchType: "ALL", conditions: exclusion },
});
const tagRule = { appliedDisjunctively: false, rules: [{ column: "TAG", relation: "EQUALS", condition: "linen", conditionObject: null }] };

describe("collection sources (Admin API 2026-07+)", () => {
  it("copies exclusions, sub-collections and conditions only the new model holds, keeping what only the target has", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), {
      collections: [
        { id: "gid://shopify/Collection/1", handle: "tops" },
        {
          id: "gid://shopify/Collection/2",
          handle: "linen",
          ruleSet: tagRule,
          sources: [
            condSource("gid://shopify/CollectionConditionsSource/1", [], [
              { __typename: "CollectionSourceExclusionConditionProductTag", id: "x1", matchType: "ANY", relation__ProductTag: "EQUALS", values__ProductTag: ["sale"] },
              { __typename: "CollectionSourceExclusionConditionCollection", id: "x2", matchType: "ANY", values__Collection: [{ id: "gid://shopify/Collection/1" }] },
            ]),
          ],
        },
        {
          id: "gid://shopify/Collection/3",
          handle: "live",
          sources: [
            condSource(
              "gid://shopify/CollectionConditionsSource/3",
              [
                { __typename: "CollectionSourceInclusionConditionProductStatus", id: "i1", matchType: "ANY", relation__ProductStatus: "EQUALS", values__ProductStatus: ["ACTIVE"] },
                { __typename: "CollectionSourceInclusionConditionProductCategory", id: "i2", matchType: "ANY", relation__ProductCategory: "EQUALS", values__ProductCategory: [{ category: { id: "gid://shopify/TaxonomyCategory/aa-1" }, includeDescendants: true }] },
              ],
              [],
              "ALL",
            ),
          ],
        },
        {
          id: "gid://shopify/Collection/4",
          handle: "all-clothes",
          sources: [{ __typename: "CollectionSubCollectionsSource", id: "gid://shopify/CollectionSubCollectionsSource/4", title: "Clothes", collections: [{ id: "gid://shopify/Collection/1" }, { id: "gid://shopify/Collection/2" }] }],
        },
      ],
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      collections: [
        { id: "gid://shopify/Collection/91", handle: "tops" },
        {
          id: "gid://shopify/Collection/92",
          handle: "linen",
          ruleSet: tagRule,
          sources: [condSource("gid://shopify/CollectionConditionsSource/92", [], [{ __typename: "CollectionSourceExclusionConditionProductVendor", id: "x9", matchType: "ANY", relation: "EQUALS", values: ["Acme"] }])],
        },
      ],
    });
    const engine = engineFor(dev, eu);
    const plan = await engine.plan("dev", "eu", { resources: ["collections"] });
    expect(plan.ops.map((o) => `${o.action} ${o.key}`)).toEqual(["create all-clothes", "create live", "update linen"]);
    const { results } = await engine.apply(plan.id);
    expect(results.filter((r) => r.outcome === "failed")).toEqual([]);

    const linen = eu.state.collections.find((c) => c.handle === "linen")!;
    const ex = linen.sources![0].exclusion.conditions.map((c: any) => c.__typename.replace("CollectionSourceExclusionCondition", ""));
    expect(ex.sort()).toEqual(["Collection", "ProductTag", "ProductVendor"]);
    expect(linen.sources![0].exclusion.conditions.find((c: any) => c.__typename.endsWith("Collection")).values).toEqual([{ id: "gid://shopify/Collection/91" }]);
    const live = eu.state.collections.find((c) => c.handle === "live")!;
    expect(live.sources![0].inclusion.conditions.find((c: any) => c.__typename.endsWith("ProductCategory")).values).toEqual([{ category: { id: "gid://shopify/TaxonomyCategory/aa-1" }, includeDescendants: true }]);
    const all = eu.state.collections.find((c) => c.handle === "all-clothes")!;
    expect(all.sources![0].collections.map((c: any) => c.id).sort()).toEqual(["gid://shopify/Collection/91", "gid://shopify/Collection/92"]);
    expect((await engine.plan("dev", "eu", { resources: ["collections"] })).ops).toEqual([]);
  });

  it("leaves sources alone on a store pinned to an older Admin API", async () => {
    const dev = new FakeShop(FakeShop.config("dev", { apiVersion: "2026-04" }), { collections: [{ id: "gid://shopify/Collection/1", handle: "tops" }] });
    const eu = new FakeShop(FakeShop.config("eu", { apiVersion: "2026-04" }), { collections: [{ id: "gid://shopify/Collection/91", handle: "tops" }] });
    await engineFor(dev, eu).plan("dev", "eu", { resources: ["collections"] });
    expect(dev.calls.filter((c) => c.field === "collections")).toHaveLength(1);
  });
});

describe("collection_products", () => {
  it("adds the products picked by hand, keeps the target's own picks and reports products the target lacks", async () => {
    const products = (prefix: string) => ["tee", "cap", "hat"].map((handle, i) => ({ id: `gid://shopify/Product/${prefix}${i + 1}`, handle }));
    const dev = new FakeShop(FakeShop.config("dev"), {
      products: products(""),
      collections: [{ id: "gid://shopify/Collection/1", handle: "picks", productIds: ["gid://shopify/Product/1", "gid://shopify/Product/2", "gid://shopify/Product/3"] }],
    });
    const eu = new FakeShop(FakeShop.config("eu"), {
      products: products("9").slice(0, 2).concat([{ id: "gid://shopify/Product/99", handle: "scarf" }]),
      collections: [{ id: "gid://shopify/Collection/91", handle: "picks", productIds: ["gid://shopify/Product/99"] }],
    });
    const engine = engineFor(dev, eu);
    const scope = { resources: ["collections"] as any, collectionProducts: true };
    const plan = await engine.plan("dev", "eu", scope);
    expect(plan.ops.map((o) => `${o.action} ${o.key}`)).toEqual(["update picks"]);
    const { results } = await engine.apply(plan.id);
    expect(results[0]!.message).toMatch(/1 product\(s\) it holds aren't in the target: hat/);
    expect([...eu.state.collections[0]!.productIds!].sort()).toEqual(["gid://shopify/Product/91", "gid://shopify/Product/92", "gid://shopify/Product/99"]);
    // Without the option, membership isn't compared.
    expect((await engine.plan("dev", "eu", { resources: ["collections"] })).ops).toEqual([]);
  });
});

describe("locations with the same name in different countries", () => {
  it("are a conflict, not a move", async () => {
    const dev = new FakeShop(FakeShop.config("dev"), { locations: [{ id: "gid://shopify/Location/1", name: "Shop location", address: { countryCode: "US", city: "Austin" } }] });
    const eu = new FakeShop(FakeShop.config("eu"), { locations: [{ id: "gid://shopify/Location/91", name: "Shop location", address: { countryCode: "FR", city: "Paris" } }] });
    const plan = await engineFor(dev, eu).plan("dev", "eu", { resources: ["locations"] });
    expect(plan.ops).toMatchObject([{ action: "conflict", key: "Shop location", reason: expect.stringMatching(/in US in the source and FR in the target/) }]);
  });
});
