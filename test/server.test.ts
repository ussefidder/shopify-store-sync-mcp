import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { StoreRegistry, type StoreConfig } from "../src/config.js";
import { PlanStore } from "../src/plan.js";
import { createServer } from "../src/server.js";
import { FakeShop } from "./fakeShop.js";

type Answer = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

/**
 * `answer` plays the person at the client: when given, the client says it can ask them
 * (elicitation) and replies with it. Without it the client can't ask anyone.
 */
async function connect(opts: { answer?: (message: string) => Answer; env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
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
    env: opts.env ?? {},
    cwd: opts.cwd ?? mkdtempSync(join(tmpdir(), "base-")),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: opts.answer ? { elicitation: {} } : {} });
  const asked: string[] = [];
  if (opts.answer) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params.message);
      return opts.answer!(req.params.message);
    });
  }
  await Promise.all([server.connect(a), client.connect(b)]);
  const progress: { progress: number; total?: number; message?: string }[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args }, undefined, { onprogress: (p) => progress.push(p) })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    const text = res.content[0]!.text;
    return { isError: Boolean(res.isError), text, json: res.isError ? undefined : JSON.parse(text) };
  };
  return { client, call, dev, prod, asked, progress };
}

const SCOPE = { source: "dev", target: "prod", resources: ["redirects", "pages"] };

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

  it("diffs, plans and applies end to end once the person confirms the protected store", async () => {
    const { call, prod } = await connect({ answer: () => ({ action: "accept", content: { domain: "prod.myshopify.com" } }) });

    const diff = await call("diff_stores", { source: "dev", target: "prod", resources: ["redirects", "pages"] });
    expect(diff.json.resources.map((r: any) => [r.kind, r.counts.onlyInSource])).toEqual([
      ["redirects", 1],
      ["pages", 1],
    ]);

    const plan = await call("plan_sync", { source: "dev", target: "prod", resources: ["redirects", "pages"] });
    expect(plan.json.totals).toEqual({ create: 2, update: 0, conflict: 0 });
    expect(plan.json.targetProtected).toBe(true);
    expect(prod.mutations()).toEqual([]);

    const applied = await call("apply_plan", { plan_id: plan.json.plan_id });
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

  describe("protected stores", () => {
    it("can't be confirmed by the assistant: the domain it can read from list_stores is not accepted", async () => {
      const { call, prod } = await connect();
      const plan = await call("plan_sync", SCOPE);
      expect((await call("list_stores")).text).toContain("prod.myshopify.com");

      const refused = await call("apply_plan", { plan_id: plan.json.plan_id, confirm: "prod.myshopify.com" });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/Refused: .*protected and this client can't ask a person to confirm/);
      expect(refused.text).toContain(`shopify-store-sync-mcp apply ${plan.json.plan_id} --confirm`);
      // The refusal doesn't hand over the value to type.
      expect(refused.text).not.toContain("prod.myshopify.com");
      expect(prod.mutations()).toEqual([]);
    });

    it("asks the person through the client, and writes nothing when they decline or mistype", async () => {
      for (const answer of [{ action: "decline" } as Answer, { action: "accept", content: { domain: "dev.myshopify.com" } } as Answer]) {
        const { call, prod, asked } = await connect({ answer: () => answer });
        const plan = await call("plan_sync", SCOPE);
        const refused = await call("apply_plan", { plan_id: plan.json.plan_id });
        expect(refused.isError).toBe(true);
        expect(refused.text).toMatch(answer.action === "decline" ? /was declined; nothing was written/ : /confirmation doesn't match/);
        expect(asked[0]).toMatch(/Apply 2 create\(s\) and 0 update\(s\) from dev to the protected store prod\? Type prod\.myshopify\.com to confirm\./);
        expect(prod.mutations()).toEqual([]);
      }
    });

    it("doesn't ask anyone when the plan can't be applied anyway", async () => {
      const { call, asked } = await connect({ answer: () => ({ action: "accept", content: { domain: "prod.myshopify.com" } }) });
      const plan = await call("plan_sync", SCOPE);
      await call("apply_plan", { plan_id: plan.json.plan_id });
      const again = await call("apply_plan", { plan_id: plan.json.plan_id });
      expect(again.text).toMatch(/Refused: plan was already applied/);
      expect(asked).toHaveLength(1);
    });

    it("lets unattended setups opt in to a confirmation passed as an argument", async () => {
      const { call, prod } = await connect({ env: { SYNC_ALLOW_AGENT_CONFIRM: "true" } });
      const plan = await call("plan_sync", SCOPE);
      expect((await call("apply_plan", { plan_id: plan.json.plan_id })).text).toMatch(/Refused: .*Pass confirm/);
      const applied = await call("apply_plan", { plan_id: plan.json.plan_id, confirm: "prod.myshopify.com" });
      expect(applied.json.totals.created).toBe(2);
      expect(prod.mutations()).toHaveLength(2);
    });
  });

  it("keeps snapshot folders inside the base folder", async () => {
    const base = mkdtempSync(join(tmpdir(), "base-"));
    const { call } = await connect({ cwd: base });
    const outside = mkdtempSync(join(tmpdir(), "elsewhere-"));

    for (const dir of [outside, "../escape", join(base, "..", "x")]) {
      const res = await call("export_snapshot", { store: "dev", dir });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/outside the snapshot base folder/);
    }
    expect(readdirSync(outside)).toEqual([]);
    expect((await call("diff_stores", { source: `dir:${outside}`, target: "prod" })).text).toMatch(/outside the snapshot base folder/);

    const ok = await call("export_snapshot", { store: "dev", dir: "config/dev", resources: ["pages"] });
    expect(ok.json.dir).toBe(join(base, "config", "dev"));
    expect(existsSync(join(base, "config", "dev", "pages", "faq.json"))).toBe(true);
    const diff = await call("diff_stores", { source: "dir:config/dev", target: "prod", resources: ["pages"] });
    expect(diff.json.resources[0].counts.onlyInSource).toBe(1);

    // SYNC_SNAPSHOT_DIR moves the base; a server started in the filesystem root has no base at all.
    const elsewhere = await connect({ cwd: base, env: { SYNC_SNAPSHOT_DIR: outside } });
    expect((await elsewhere.call("export_snapshot", { store: "dev", dir: "snap", resources: ["pages"] })).json.dir).toBe(join(outside, "snap"));
    const rooted = await connect({ cwd: parse(base).root });
    expect((await rooted.call("export_snapshot", { store: "dev", dir: "tmp/x" })).text).toMatch(/Set SYNC_SNAPSHOT_DIR/);
  });

  it("reports progress while reading and while applying, for clients that ask for it", async () => {
    const { call, progress } = await connect({ answer: () => ({ action: "accept", content: { domain: "prod.myshopify.com" } }) });
    const plan = await call("plan_sync", SCOPE);
    expect(progress.map((p) => p.message)).toEqual(expect.arrayContaining(["read 1 pages from dev", "read 0 redirects from prod"]));
    progress.length = 0;
    await call("apply_plan", { plan_id: plan.json.plan_id });
    expect(progress.map((p) => `${p.progress}/${p.total}`).sort()).toEqual(["1/2", "2/2"]);
  });

  it("creates pages hidden with as_drafts and says so in the plan", async () => {
    const { call, prod } = await connect({ answer: () => ({ action: "accept", content: { domain: "prod.myshopify.com" } }) });
    const live = await call("plan_sync", { ...SCOPE, resources: ["pages"] });
    expect(live.json.warnings.join("\n")).toMatch(/1 new page\(s\) will be visible in prod as soon as created/);

    const plan = await call("plan_sync", { ...SCOPE, resources: ["pages"], as_drafts: true });
    expect(plan.json.warnings.join("\n")).toMatch(/New pages will be created hidden/);
    await call("apply_plan", { plan_id: plan.json.plan_id });
    expect(prod.state.pages[0]).toMatchObject({ handle: "faq", isPublished: false });
  });

  it("has a registry entry (server.json) that matches the npm package", () => {
    const read = (f: string) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
    const pkg = read("package.json");
    const entry = read("server.json");
    expect(entry.name).toBe(pkg.mcpName);
    expect(entry.name).toMatch(/^io\.github\.ussefidder\//);
    expect(entry.version).toBe(pkg.version);
    expect(entry.packages).toEqual([expect.objectContaining({ registryType: "npm", identifier: pkg.name, version: pkg.version, transport: { type: "stdio" } })]);
    expect(entry.description.length).toBeLessThanOrEqual(100);
  });

  it("reports its version from package.json", async () => {
    const { client } = await connect();
    expect(client.getServerVersion()?.version).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  });
});
