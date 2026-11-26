import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StoreRegistry, type StoreConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { PlanStore } from "../src/plan.js";
import { convertValue } from "../src/typeConvert.js";
import { FakeShop } from "./fakeShop.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function engineFor(...shops: FakeShop[]) {
  process.env.SYNC_AUDIT_LOG = join(tmp("audit-"), "audit.log");
  process.env.SYNC_STATE_DIR = tmp("state-");
  const byAlias = Object.fromEntries(shops.map((s) => [s.store.alias, s]));
  return new Engine(new StoreRegistry(shops.map((s) => s.store)), new PlanStore(tmp("plans-")), (s: StoreConfig) => byAlias[s.alias]!);
}

const def = (id: string, type: string) => ({
  id,
  name: "Size",
  namespace: "custom",
  key: "size",
  description: null,
  ownerType: "PRODUCT",
  pinnedPosition: null,
  type: { name: type },
  access: { storefront: "PUBLIC_READ", customerAccount: "NONE" },
  capabilities: { adminFilterable: { enabled: false }, smartCollectionCondition: { enabled: false }, uniqueValues: { enabled: false } },
  validations: [],
});

const size = (type: string, value: string) => [{ namespace: "custom", key: "size", type, value }];

describe("convertValue", () => {
  it("wraps a single value in a list and unwraps a list of one", () => {
    expect(convertValue("M", "single_line_text_field", "list.single_line_text_field")).toEqual({ value: '["M"]' });
    expect(convertValue("42", "number_integer", "list.number_integer")).toEqual({ value: "[42]" });
    expect(convertValue("4.50", "number_decimal", "list.number_decimal")).toEqual({ value: '["4.50"]' });
    expect(convertValue('{"value":2,"unit":"KILOGRAMS"}', "weight", "list.weight")).toEqual({ value: '[{"value":2,"unit":"KILOGRAMS"}]' });
    expect(convertValue("gid://shopify/Product/1", "product_reference", "list.product_reference")).toEqual({ value: '["gid://shopify/Product/1"]' });
    expect(convertValue('["M"]', "list.single_line_text_field", "single_line_text_field")).toEqual({ value: "M" });
    expect(convertValue("[42]", "list.number_integer", "number_integer")).toEqual({ value: "42" });
  });

  it("refuses what can't be converted, with the reason", () => {
    expect(convertValue('["S","M"]', "list.single_line_text_field", "single_line_text_field")).toEqual({ error: "2 values can't fit in one single_line_text_field" });
    expect(convertValue("M", "single_line_text_field", "number_integer")).toEqual({ error: "single_line_text_field can't be converted to number_integer" });
    expect(convertValue("a\nb", "multi_line_text_field", "single_line_text_field")).toMatchObject({ error: expect.stringMatching(/line breaks/) });
    expect(convertValue("true", "boolean", "list.boolean")).toEqual({ error: "boolean has no list form" });
  });
});

describe("type_mismatch: convert_values", () => {
  it("keeps the target's list definition and writes the source's single values as lists", async () => {
    const staging = new FakeShop(FakeShop.config("staging"), {
      metafieldDefinitions: [def("gid://shopify/MetafieldDefinition/1", "single_line_text_field")],
      products: [
        { id: "gid://shopify/Product/1", handle: "tee", metafields: size("single_line_text_field", "M") },
        { id: "gid://shopify/Product/2", handle: "cap", metafields: size("single_line_text_field", "L") },
      ],
    });
    const dev = new FakeShop(FakeShop.config("dev"), {
      metafieldDefinitions: [def("gid://shopify/MetafieldDefinition/91", "list.single_line_text_field")],
      products: [
        { id: "gid://shopify/Product/91", handle: "tee" },
        { id: "gid://shopify/Product/92", handle: "cap", metafields: size("list.single_line_text_field", '["S"]') },
      ],
    });
    const engine = engineFor(staging, dev);
    const scope = { resources: ["metafield_definitions", "metafields"] as any, include: ["PRODUCT.custom.size", "PRODUCT/*"] };

    const plain = await engine.plan("staging", "dev", scope);
    expect(plain.ops.filter((o) => o.action === "conflict").map((o) => o.key)).toEqual(["PRODUCT.custom.size", "PRODUCT/cap/custom.size"]);

    const plan = await engine.plan("staging", "dev", { ...scope, typeMismatch: "convert_values" });
    expect(plan.ops.map((o) => `${o.action} ${o.key}`)).toEqual(["create PRODUCT/tee/custom.size", "update PRODUCT/cap/custom.size"]);
    expect(plan.warnings).toContain("2 metafield value(s) will be converted to the target definition's type (a single value becomes a list of one, a list of one a single value).");
    const { results } = await engine.apply(plan.id);
    expect(results.filter((r) => r.outcome === "failed")).toEqual([]);
    expect(dev.state.metafieldDefinitions[0]!.type.name).toBe("list.single_line_text_field");
    expect(dev.state.products.map((p) => p.metafields?.[0]?.value)).toEqual(['["M"]', '["L"]']);
    expect((await engine.plan("staging", "dev", { ...scope, typeMismatch: "convert_values" })).ops).toEqual([]);
  });

  it("reports a list of several values that can't become a single value", async () => {
    const staging = new FakeShop(FakeShop.config("staging"), {
      metafieldDefinitions: [def("gid://shopify/MetafieldDefinition/1", "list.single_line_text_field")],
      products: [{ id: "gid://shopify/Product/1", handle: "tee", metafields: size("list.single_line_text_field", '["S","M"]') }],
    });
    const dev = new FakeShop(FakeShop.config("dev"), {
      metafieldDefinitions: [def("gid://shopify/MetafieldDefinition/91", "single_line_text_field")],
      products: [{ id: "gid://shopify/Product/91", handle: "tee" }],
    });
    const plan = await engineFor(staging, dev).plan("staging", "dev", { resources: ["metafields"], typeMismatch: "convert_values" });
    expect(plan.ops).toMatchObject([{ action: "conflict", key: "PRODUCT/tee/custom.size", reason: expect.stringMatching(/2 values can't fit in one single_line_text_field/) }]);
  });
});

describe("type_mismatch: retype_definitions", () => {
  it("recreates the target's definition with the source's type, keeping and converting its values", async () => {
    const staging = new FakeShop(FakeShop.config("staging"), {
      metafieldDefinitions: [def("gid://shopify/MetafieldDefinition/1", "list.single_line_text_field")],
      products: [{ id: "gid://shopify/Product/1", handle: "tee", metafields: size("list.single_line_text_field", '["S","M"]') }],
    });
    const dev = new FakeShop(FakeShop.config("dev"), {
      metafieldDefinitions: [def("gid://shopify/MetafieldDefinition/91", "single_line_text_field")],
      products: [
        { id: "gid://shopify/Product/91", handle: "tee", metafields: size("single_line_text_field", "M") },
        { id: "gid://shopify/Product/92", handle: "dev-only", metafields: size("single_line_text_field", "XL") },
      ],
    });
    const engine = engineFor(staging, dev);
    const scope = { resources: ["metafield_definitions", "metafields"] as any, typeMismatch: "retype_definitions" as const };

    const plan = await engine.plan("staging", "dev", scope);
    expect(plan.ops.map((o) => `${o.action} ${o.key}`)).toEqual(["update PRODUCT.custom.size", "update PRODUCT/tee/custom.size"]);
    expect(plan.warnings.join("\n")).toMatch(/PRODUCT\.custom\.size will be deleted in the target and created again/);
    const { results } = await engine.apply(plan.id);
    expect(results.filter((r) => r.outcome === "failed")).toEqual([]);

    expect(dev.state.metafieldDefinitions.map((d) => d.type.name)).toEqual(["list.single_line_text_field"]);
    expect(dev.state.products.map((p) => p.metafields?.[0])).toEqual([
      { namespace: "custom", key: "size", type: "list.single_line_text_field", value: '["S","M"]' },
      { namespace: "custom", key: "size", type: "list.single_line_text_field", value: '["XL"]' },
    ]);
    const backups = join(process.env.SYNC_STATE_DIR!, "backups");
    expect(existsSync(backups)).toBe(true);
    const { readdirSync } = await import("node:fs");
    const saved = JSON.parse(readFileSync(join(backups, readdirSync(backups)[0]!), "utf8"));
    expect(saved.values.map((v: { value: string }) => v.value)).toEqual(["M", "XL"]);
    expect((await engine.plan("staging", "dev", scope)).ops).toEqual([]);
  });

  it("leaves type conflicts alone without the option", async () => {
    const staging = new FakeShop(FakeShop.config("staging"), { metafieldDefinitions: [def("gid://shopify/MetafieldDefinition/1", "list.single_line_text_field")] });
    const dev = new FakeShop(FakeShop.config("dev"), { metafieldDefinitions: [def("gid://shopify/MetafieldDefinition/91", "single_line_text_field")] });
    const plan = await engineFor(staging, dev).plan("staging", "dev", { resources: ["metafield_definitions"] });
    expect(plan.ops).toMatchObject([{ action: "conflict", reason: expect.stringMatching(/can't change a definition's type in place/) }]);
  });
});
