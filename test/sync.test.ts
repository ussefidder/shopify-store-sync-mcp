import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { applyPlan, ApplyRefused } from "../src/apply.js";
import { diffItems } from "../src/diff.js";
import { buildPlan, type Plan } from "../src/plan.js";
import { RefToGidResolver } from "../src/refs.js";
import { RESOURCE_KINDS, type ResourceKind } from "../src/resources/index.js";
import { takeSnapshot } from "../src/snapshot.js";
import { FakeShop } from "./fakeShop.js";

const FAQ_DEF_SRC = "gid://shopify/MetaobjectDefinition/1";

function sourceShop() {
  return new FakeShop(FakeShop.config("dev"), {
    products: [{ id: "gid://shopify/Product/11", handle: "linen-shirt" }],
    files: [{ id: "gid://shopify/MediaImage/77" }],
    metafieldDefinitions: [
      mfDef("gid://shopify/MetafieldDefinition/1", "material", "single_line_text_field"),
      mfDef("gid://shopify/MetafieldDefinition/2", "size_chart", "multi_line_text_field"),
      { ...mfDef("gid://shopify/MetafieldDefinition/3", "x", "boolean"), namespace: "app--123--reviews" },
    ],
    metaobjectDefinitions: [
      {
        id: FAQ_DEF_SRC,
        type: "faq",
        name: "FAQ",
        description: null,
        displayNameKey: "question",
        access: { storefront: "PUBLIC_READ", customerAccount: "NONE" },
        capabilities: {
          publishable: { enabled: true },
          translatable: { enabled: true },
          renderable: { enabled: false },
          onlineStore: { enabled: false, data: null },
        },
        fieldDefinitions: [
          field("question", "single_line_text_field", true),
          field("product", "product_reference"),
          field("see_also", "metaobject_reference", false, [{ name: "metaobject_definition_id", value: FAQ_DEF_SRC }]),
          field("image", "file_reference"),
        ],
      },
    ],
    metaobjects: [
      mo("gid://shopify/Metaobject/21", "faq", "care", {
        question: "How do I wash linen?",
        product: "gid://shopify/Product/11",
        see_also: "gid://shopify/Metaobject/22",
        image: "gid://shopify/MediaImage/77",
      }),
      mo("gid://shopify/Metaobject/22", "faq", "returns", { question: "Can I return it?" }),
    ],
    pages: [
      { id: "gid://shopify/Page/31", handle: "about", title: "About us", body: "<p>New copy</p>", isPublished: true, templateSuffix: null },
    ],
    menus: [
      {
        id: "gid://shopify/Menu/41",
        handle: "main-menu",
        title: "Main menu",
        items: [
          { title: "About", type: "PAGE", url: "https://dev.example/pages/about", resourceId: "gid://shopify/Page/31", tags: [], items: [] },
          { title: "Blog", type: "HTTP", url: "https://blog.example.com", resourceId: null, tags: [], items: [] },
        ],
      },
    ],
    redirects: [{ id: "gid://shopify/UrlRedirect/51", path: "/old-shirt", target: "/products/linen-shirt" }],
  });
}

function targetShop(extra: Partial<Parameters<typeof FakeShop.config>[1]> = {}) {
  return new FakeShop(FakeShop.config("prod", extra), {
    products: [{ id: "gid://shopify/Product/9011", handle: "linen-shirt" }],
    metafieldDefinitions: [mfDef("gid://shopify/MetafieldDefinition/901", "size_chart", "json")],
    pages: [
      { id: "gid://shopify/Page/9031", handle: "about", title: "About us", body: "<p>Old copy</p>", isPublished: true, templateSuffix: null },
    ],
    menus: [{ id: "gid://shopify/Menu/9041", handle: "main-menu", title: "Main menu", items: [] }],
    redirects: [{ id: "gid://shopify/UrlRedirect/9051", path: "/legacy", target: "/" }],
  });
}

function mfDef(id: string, key: string, type: string) {
  return {
    id,
    name: key,
    namespace: "custom",
    key,
    description: null,
    ownerType: "PRODUCT",
    pinnedPosition: null,
    type: { name: type },
    access: { storefront: "PUBLIC_READ", customerAccount: "NONE" },
    capabilities: { adminFilterable: { enabled: false }, smartCollectionCondition: { enabled: false }, uniqueValues: { enabled: false } },
    validations: [],
  };
}

function field(key: string, type: string, required = false, validations: { name: string; value: string }[] = []) {
  return {
    key,
    name: key,
    description: null,
    required,
    type: { name: type },
    validations,
    capabilities: { adminFilterable: { enabled: false } },
  };
}

function mo(id: string, type: string, handle: string, values: Record<string, string>) {
  return {
    id,
    type,
    handle,
    fields: Object.entries(values).map(([key, value]) => ({ key, value })),
    capabilities: { publishable: { status: "ACTIVE" } },
  };
}

async function plan(src: FakeShop, tgt: FakeShop, kinds: ResourceKind[] = [...RESOURCE_KINDS]): Promise<Plan> {
  const [a, b] = await Promise.all([takeSnapshot(src, kinds), takeSnapshot(tgt, kinds)]);
  const diffs = kinds.map((k) => diffItems(k, a.resources[k]?.items ?? [], b.resources[k]?.items ?? []));
  return buildPlan({
    source: { alias: src.store.alias, domain: src.store.domain },
    target: { alias: tgt.store.alias, domain: tgt.store.domain },
    diffs,
    skipped: kinds.flatMap((k) => (a.resources[k]?.skipped ?? []).map((x) => ({ kind: k, ...x }))),
    resolver: new RefToGidResolver(tgt),
  });
}

let auditLog: string;
beforeEach(() => {
  auditLog = join(mkdtempSync(join(tmpdir(), "sync-test-")), "audit.log");
});

describe("snapshot", () => {
  it("rewrites GIDs into portable refs and skips app-owned definitions", async () => {
    const snap = await takeSnapshot(sourceShop(), ["metaobjects", "metaobject_definitions", "metafield_definitions"]);
    const care = snap.resources.metaobjects!.items.find((i) => i.key === "faq/care")!;
    expect(care.data.fields).toEqual({
      question: "How do I wash linen?",
      product: "shopify://Product/linen-shirt",
      see_also: "shopify://Metaobject/faq/returns",
      image: "shopify://unresolved/MediaImage/77",
    });
    const def = snap.resources.metaobject_definitions!.items[0]!;
    const seeAlso = (def.data.fields as any[]).find((f) => f.key === "see_also");
    expect(seeAlso.validations).toEqual([{ name: "metaobject_definition_id", value: "shopify://MetaobjectDefinition/faq" }]);
    expect(snap.resources.metafield_definitions!.skipped).toEqual([{ key: "PRODUCT.app--123--reviews.x", reason: "app-owned" }]);
  });
});

describe("plan", () => {
  it("lists creates, updates and conflicts without writing anything", async () => {
    const src = sourceShop();
    const tgt = targetShop();
    const p = await plan(src, tgt);

    const summary = p.ops.map((o) => `${o.action} ${o.kind} ${o.key}`);
    expect(summary).toEqual([
      "create metafield_definitions PRODUCT.custom.material",
      "conflict metafield_definitions PRODUCT.custom.size_chart",
      "create metaobject_definitions faq",
      "update pages about",
      "create metaobjects faq/care",
      "create metaobjects faq/returns",
      "update menus main-menu",
      "create redirects /old-shirt",
    ]);
    expect(p.ops.find((o) => o.key === "about")!.changes).toEqual([{ path: "body", source: "<p>New copy</p>", target: "<p>Old copy</p>" }]);
    expect(p.onlyInTarget).toEqual([{ kind: "redirects", keys: ["/legacy"] }]);
    expect(p.warnings.join("\n")).toMatch(/1 conflict/);
    expect(p.warnings.join("\n")).toMatch(/can't be matched across stores/);
    expect(tgt.mutations()).toEqual([]);
  });

  it("does not flag refs that the plan itself will create", async () => {
    const p = await plan(sourceShop(), targetShop());
    const care = p.ops.find((o) => o.key === "faq/care")!;
    // faq/returns is created by the same plan; the file can never be mapped.
    expect(care.missingRefs).toEqual(["shopify://unresolved/MediaImage/77"]);
  });
});

describe("apply", () => {
  it("creates and updates resources with IDs remapped to the target", async () => {
    const tgt = targetShop();
    const p = await plan(sourceShop(), tgt);
    const results = await applyPlan(p, tgt, { auditLog });

    expect(results.map((r) => `${r.outcome} ${r.key}`)).toEqual([
      "created PRODUCT.custom.material",
      "skipped PRODUCT.custom.size_chart",
      "created faq",
      "updated about",
      "created faq/care",
      "created faq/returns",
      "updated main-menu",
      "created /old-shirt",
    ]);
    expect(p.status).toBe("applied");

    const s = tgt.state;
    const faqDef = s.metaobjectDefinitions.find((d) => d.type === "faq");
    const seeAlso = faqDef.fieldDefinitions.find((f: any) => f.key === "see_also");
    expect(seeAlso.validations).toEqual([{ name: "metaobject_definition_id", value: faqDef.id }]);

    const returns = s.metaobjects.find((o) => o.handle === "returns");
    const care = s.metaobjects.find((o) => o.handle === "care");
    const value = (k: string) => care.fields.find((f: any) => f.key === k)?.value;
    expect(value("product")).toBe("gid://shopify/Product/9011");
    expect(value("see_also")).toBe(returns.id);
    expect(value("image")).toBeUndefined();

    const menu = s.menus.find((m) => m.handle === "main-menu");
    expect(menu.items.map((i: any) => [i.title, i.resourceId ?? i.url])).toEqual([
      ["About", "gid://shopify/Page/9031"],
      ["Blog", "https://blog.example.com"],
    ]);
    expect(s.pages[0].body).toBe("<p>New copy</p>");
    expect(s.redirects.map((r) => r.path).sort()).toEqual(["/legacy", "/old-shirt"]);

    const lines = readFileSync(auditLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.some((l) => l.key === "faq/care" && l.target === "prod.myshopify.com")).toBe(true);
  });

  it("is a no-op the second time: a fresh plan after applying is empty apart from conflicts", async () => {
    const src = sourceShop();
    const tgt = targetShop();
    await applyPlan(await plan(src, tgt), tgt, { auditLog });
    const again = await plan(src, tgt);
    expect(again.ops.map((o) => `${o.action} ${o.key}`)).toEqual(["conflict PRODUCT.custom.size_chart"]);
  });

  it("refuses when writes are disabled", async () => {
    const tgt = targetShop({ allowWrites: false });
    const p = await plan(sourceShop(), tgt);
    await expect(applyPlan(p, tgt, { auditLog })).rejects.toThrow(ApplyRefused);
    expect(tgt.mutations()).toEqual([]);
  });

  it("requires the domain as confirmation for protected stores", async () => {
    const tgt = targetShop({ protected: true });
    const p = await plan(sourceShop(), tgt, ["redirects"]);
    await expect(applyPlan(p, tgt, { auditLog })).rejects.toThrow(/protected. A person has to confirm/);
    await expect(applyPlan(p, tgt, { auditLog, confirm: "prod" })).rejects.toThrow(ApplyRefused);
    const results = await applyPlan(p, tgt, { auditLog, confirm: "prod.myshopify.com" });
    expect(results.map((r) => r.outcome)).toEqual(["created"]);
  });

  it("refuses expired plans and plans that were already applied", async () => {
    const tgt = targetShop();
    const p = await plan(sourceShop(), tgt, ["redirects"]);
    await expect(applyPlan(p, tgt, { auditLog, now: new Date(Date.now() + 2 * 60 * 60 * 1000) })).rejects.toThrow(/expired/);
    await applyPlan(p, tgt, { auditLog });
    await expect(applyPlan(p, tgt, { auditLog })).rejects.toThrow(/already applied/);
  });

  it("skips updates whose target changed after planning", async () => {
    const tgt = targetShop();
    const p = await plan(sourceShop(), tgt, ["pages", "redirects"]);
    tgt.state.pages[0].title = "Edited by a merchant in the meantime";
    const results = await applyPlan(p, tgt, { auditLog });
    expect(results.find((r) => r.key === "about")).toMatchObject({ outcome: "skipped", message: expect.stringMatching(/changed since/) });
    expect(results.find((r) => r.key === "/old-shirt")?.outcome).toBe("created");
    expect(tgt.state.pages[0].body).toBe("<p>Old copy</p>");
  });

  it("only applies selected ops and keeps the plan open for the rest", async () => {
    const tgt = targetShop();
    const p = await plan(sourceShop(), tgt, ["redirects", "pages"]);
    const redirectSeq = p.ops.find((o) => o.kind === "redirects")!.seq;
    const results = await applyPlan(p, tgt, { auditLog, only: [redirectSeq] });
    expect(results.map((r) => r.key)).toEqual(["/old-shirt"]);
    expect(p.status).toBe("pending");
    expect(tgt.state.pages[0].body).toBe("<p>Old copy</p>");
  });

  it("fails an op whose references don't exist in the target, without stopping the rest", async () => {
    const tgt = targetShop();
    tgt.state.products = []; // the shirt isn't in the target store
    tgt.state.pages = [];
    const p = await plan(sourceShop(), tgt, ["metaobject_definitions", "metaobjects", "menus"]);
    expect(p.warnings.join("\n")).toMatch(/shopify:\/\/Product\/linen-shirt/);
    const results = await applyPlan(p, tgt, { auditLog });
    expect(results.find((r) => r.key === "main-menu")).toMatchObject({ outcome: "failed", message: expect.stringMatching(/Page\/about/) });
    // Metaobjects are written without the missing reference; the second pass reports what's still missing.
    expect(results.find((r) => r.key === "faq/care")).toMatchObject({ outcome: "failed", message: expect.stringMatching(/Product\/linen-shirt/) });
    expect(tgt.state.metaobjects.find((o) => o.handle === "care")).toBeDefined();
    expect(results.find((r) => r.key === "faq/returns")?.outcome).toBe("created");
    expect(p.status).toBe("partially_applied");
  });

  it("remaps customer account pages (which the nodes query can't return) and drops menu links it can't map", async () => {
    const src = new FakeShop(FakeShop.config("dev"), {
      customerAccountPages: [{ id: "gid://shopify/CustomerAccountPage/1", handle: "orders" }],
      menus: [
        {
          id: "gid://shopify/Menu/1",
          handle: "customer-account-main-menu",
          title: "Customer account main menu",
          items: [
            { title: "Orders", type: "CUSTOMER_ACCOUNT_PAGE", url: "https://shopify.com/1/account/orders", resourceId: "gid://shopify/CustomerAccountPage/1", tags: [], items: [] },
            { title: "Lookbook", type: "HTTP", url: "/lookbook", resourceId: "gid://shopify/GenericFile/9", tags: [], items: [] },
          ],
        },
      ],
    });
    const tgt = new FakeShop(FakeShop.config("prod"), {
      customerAccountPages: [{ id: "gid://shopify/CustomerAccountPage/77", handle: "orders" }],
      menus: [{ id: "gid://shopify/Menu/9", handle: "customer-account-main-menu", title: "Customer account main menu", items: [] }],
    });

    const snap = await takeSnapshot(src, ["menus"]);
    const items = snap.resources.menus!.items[0]!.data.items as { resourceId?: string }[];
    expect(items.map((i) => i.resourceId)).toEqual(["shopify://CustomerAccountPage/orders", "shopify://unresolved/GenericFile/9"]);

    const results = await applyPlan(await plan(src, tgt, ["menus"]), tgt, { auditLog });
    expect(results.map((r) => r.outcome)).toEqual(["updated"]);
    expect(tgt.state.menus[0].items.map((i: any) => [i.title, i.resourceId])).toEqual([["Orders", "gid://shopify/CustomerAccountPage/77"]]);
  });
});
