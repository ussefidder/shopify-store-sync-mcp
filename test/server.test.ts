import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { StoreRegistry, type StoreConfig } from "../src/config.js";
import { PlanStore } from "../src/plan.js";
import { createServer } from "../src/server.js";
import { FakeShop } from "./fakeShop.js";

async function connect() {
  process.env.SYNC_AUDIT_LOG = join(mkdtempSync(join(tmpdir(), "audit-")), "audit.log");
  const dev = new FakeShop(FakeShop.config("dev", { accessToken: "shpat_secret_dev" }), {
    redirects: [{ id: "gid://shopify/UrlRedirect/1", path: "/a", target: "/b" }],
    pages: [{ id: "gid://shopify/Page/1", handle: "faq", title: "FAQ", body: "x", isPublished: true, templateSuffix: null }],
  });
  const prod = new FakeShop(FakeShop.config("prod", { protected: true }));
  const shops: Record<string, FakeShop> = { dev, prod };
  const registry = new StoreRegistry([dev.store, prod.store]);
  const server = createServer({
    registry,
    plans: new PlanStore(mkdtempSync(join(tmpdir(), "plans-"))),
    clientFactory: (s: StoreConfig) => shops[s.alias]!,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content[0]!.text;
    return { isError: Boolean(res.isError), text, json: res.isError ? undefined : JSON.parse(text) };
  };
  return { client, call, prod };
}

describe("MCP server", () => {
  it("exposes the tools with read-only hints on everything except apply_plan", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["apply_plan", "diff_stores", "diff_themes", "export_snapshot", "get_plan", "list_resource_types", "list_stores", "plan_sync", "snapshot_store"].sort(),
    );
    // export_snapshot writes local files only; apply_plan is the one tool that writes to Shopify.
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(!["apply_plan", "export_snapshot"].includes(t.name));
    expect(tools.find((t) => t.name === "export_snapshot")?.annotations?.destructiveHint).toBe(false);
  });

  it("never returns secrets from list_stores", async () => {
    const { call } = await connect();
    const res = await call("list_stores");
    expect(res.text).not.toContain("shpat_secret_dev");
    expect(res.json.stores[0]).toMatchObject({ alias: "dev", auth: "access_token", allowWrites: true });
  });

  it("diffs, plans and applies end to end, honoring protection", async () => {
    const { call, prod } = await connect();

    const diff = await call("diff_stores", { source: "dev", target: "prod", resources: ["redirects", "pages"] });
    expect(diff.json.resources.map((r: any) => [r.kind, r.counts.onlyInSource])).toEqual([
      ["redirects", 1],
      ["pages", 1],
    ]);

    const plan = await call("plan_sync", { source: "dev", target: "prod", resources: ["redirects", "pages"] });
    expect(plan.json.totals).toEqual({ create: 2, update: 0, conflict: 0 });
    expect(plan.json.targetProtected).toBe(true);
    expect(prod.mutations()).toEqual([]);

    const refused = await call("apply_plan", { plan_id: plan.json.plan_id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Refused: .*protected/);

    const applied = await call("apply_plan", { plan_id: plan.json.plan_id, confirm: "prod.myshopify.com" });
    expect(applied.json.totals).toEqual({ created: 2, updated: 0, skipped: 0, failed: 0 });
    expect(prod.mutations().sort()).toEqual(["pageCreate", "urlRedirectCreate"]);

    const listed = await call("get_plan");
    expect(listed.json.plans[0]).toMatchObject({ plan_id: plan.json.plan_id, status: "applied" });
  });

  it("returns tool errors instead of crashing", async () => {
    const { call } = await connect();
    expect((await call("diff_stores", { source: "dev", target: "dev" })).text).toMatch(/must be different/);
    expect((await call("snapshot_store", { store: "staging" })).text).toMatch(/unknown store "staging"/);
    expect((await call("apply_plan", { plan_id: "nope" })).isError).toBe(true);
  });
});
