import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { parseStores, StoreRegistry, type StoreConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { PlanStore } from "../src/plan.js";
import { parseCliOutput, quoteWindowsArg, scopesFor, ShopifyCliClient, type Runner } from "../src/shopify/cliClient.js";
import { FakeShop } from "./fakeShop.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const arg = (args: string[], name: string) => args[args.indexOf(name) + 1]!;
const progress = '{"type":"progress","status":"started","message":"Loading stored store auth"}';

/** A `shopify store execute` stand-in that answers from an in-memory store. */
function runnerFor(shop: FakeShop, calls: string[][] = []): Runner {
  return async (_bin, args) => {
    calls.push(args);
    const query = readFileSync(arg(args, "--query-file"), "utf8");
    const variables = JSON.parse(readFileSync(arg(args, "--variable-file"), "utf8"));
    if (/^\s*mutation\b/.test(query) && !args.includes("--allow-mutations")) {
      return { code: 1, stdout: JSON.stringify({ error: { message: "Mutations are disabled by default." } }), stderr: "" };
    }
    try {
      const data = await shop.request(query, variables);
      return { code: 0, stdout: `${progress}\n${JSON.stringify({ data })}\n`, stderr: "" };
    } catch (e) {
      return { code: 1, stdout: JSON.stringify({ error: { message: "GraphQL operation failed.", details: { errors: [{ message: String((e as Error).message) }] } } }), stderr: "" };
    }
  };
}

const cliStore = (alias: string, extra: Partial<StoreConfig> = {}) => FakeShop.config(alias, { auth: "shopify-cli", accessToken: undefined, ...extra });

describe("Shopify CLI sign-in", () => {
  it("accepts a store with no token or app when auth is shopify-cli", () => {
    const [s] = parseStores({ dev: { domain: "dev.myshopify.com", auth: "shopify-cli" } });
    expect(s!.auth).toBe("shopify-cli");
    expect(() => parseStores({ dev: { domain: "dev.myshopify.com" } })).toThrow(/"auth": "shopify-cli", an accessToken, or clientId/);
  });

  it("requests read-only scopes unless the store allows writes", () => {
    expect(scopesFor({ allowWrites: false }).every((s) => s.startsWith("read_"))).toBe(true);
    expect(scopesFor({ allowWrites: true })).toContain("write_metaobject_definitions");
  });

  it("runs queries through store execute and only allows mutations for mutations", async () => {
    const store = cliStore("dev");
    const calls: string[][] = [];
    const run: Runner = async (_bin, args) => (calls.push(args), { code: 0, stdout: JSON.stringify({ data: { ok: true } }), stderr: "" });
    const client = new ShopifyCliClient(store, run, "shopify");
    await client.request("query { shop { name } }");
    await client.request("mutation M($x: String!) { thing(x: $x) { id } }", { x: "1" });
    const shop = { store };
    expect(calls[0]!.slice(0, 4)).toEqual(["store", "execute", "--store", shop.store.domain]);
    expect(arg(calls[0]!, "--version")).toBe(shop.store.apiVersion);
    expect(calls[0]).toContain("--json");
    expect(calls[0]).not.toContain("--allow-mutations");
    expect(calls[1]).toContain("--allow-mutations");
  });

  it("syncs between two stores signed in through the CLI", async () => {
    const dev = new FakeShop(cliStore("dev"), {
      redirects: [{ id: "gid://shopify/UrlRedirect/1", path: "/old", target: "/new" }],
    } as any);
    const eu = new FakeShop(cliStore("eu", { allowWrites: true }), {} as any);
    const shops: Record<string, FakeShop> = { dev, eu };
    process.env.SYNC_AUDIT_LOG = join(tmp("audit-"), "audit.log");
    const engine = new Engine(
      new StoreRegistry([dev.store, eu.store]),
      new PlanStore(tmp("plans-")),
      (s: StoreConfig) => new ShopifyCliClient(s, runnerFor(shops[s.alias]!), "shopify"),
    );
    const plan = await engine.plan("dev", "eu", { resources: ["redirects"] });
    const { results } = await engine.apply(plan.id);
    expect(results.map((r) => `${r.outcome} ${r.key}`)).toEqual(["created /old"]);
    expect((eu.state as any).redirects.map((r: any) => r.path)).toEqual(["/old"]);
  });

  it("tells the user to connect when the CLI has no sign-in", async () => {
    const store = cliStore("dev");
    const run: Runner = async () => ({
      code: 1,
      stdout: `${progress}\n{"error":{"type":"abort","message":"No stored app authentication found for dev.myshopify.com.","nextSteps":[]}}`,
      stderr: "",
    });
    await expect(new ShopifyCliClient(store, run, "shopify").request("query { shop { name } }")).rejects.toThrow(
      "not signed in through Shopify CLI, or the sign-in expired or lacks a scope. Run: shopify-store-sync-mcp connect dev",
    );
  });

  it("runs at most a few CLI processes at once", async () => {
    let running = 0;
    let peak = 0;
    const run: Runner = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { code: 0, stdout: JSON.stringify({ data: { ok: true } }), stderr: "" };
    };
    const client = new ShopifyCliClient(cliStore("dev"), run, "shopify");
    await Promise.all(Array.from({ length: 12 }, () => client.request("query { shop { name } }")));
    expect(peak).toBe(4);
  });

  it("retries throttled requests", async () => {
    let n = 0;
    const run: Runner = async () =>
      n++ === 0
        ? { code: 1, stdout: JSON.stringify({ error: { message: "GraphQL operation failed.", details: { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } } }), stderr: "" }
        : { code: 0, stdout: JSON.stringify({ data: { shop: { name: "S" } } }), stderr: "" };
    const client = new ShopifyCliClient(cliStore("dev"), run, "shopify", 5, async () => {});
    await expect(client.request("query { shop { name } }")).resolves.toEqual({ shop: { name: "S" } });
    expect(n).toBe(2);
  });

  it("parses the CLI's JSON lines, ignoring progress events", () => {
    expect(parseCliOutput(`${progress}\n{"data":{"a":1},"extensions":{}}\n`)).toEqual({ data: { a: 1 }, extensions: {} });
    expect(parseCliOutput(JSON.stringify({ data: { a: 1 } }, null, 2))).toEqual({ data: { a: 1 } });
    expect(parseCliOutput("not json")).toBeUndefined();
  });

  it("reads Shopify CLI 4.9 output, where the data object is printed on its own over several lines", () => {
    const out = `${progress}\n{"type":"progress","status":"completed"}\n{\n  "shop": {\n    "name": "Soraly Studio Demo"\n  }\n}\n`;
    expect(parseCliOutput(out)).toEqual({ data: { shop: { name: "Soraly Studio Demo" } } });
    expect(parseCliOutput(`${progress}\n${JSON.stringify({ data: { shop: { name: "S" } }, extensions: { cost: 1 } }, null, 2)}`)).toEqual({
      data: { shop: { name: "S" } },
      extensions: { cost: 1 },
    });
    expect(parseCliOutput(`${progress}\n{"error":{"type":"abort","message":"nope"}}`)).toEqual({ error: { type: "abort", message: "nope" } });
  });

  it("quotes arguments for the Windows shell", () => {
    expect(quoteWindowsArg("--store")).toBe("--store");
    expect(quoteWindowsArg("C:\\Users\\a b\\q.graphql")).toBe('"C:\\Users\\a b\\q.graphql"');
    expect(quoteWindowsArg('say "hi"')).toBe('"say ""hi"""');
  });

  it("connect runs store auth with the right scopes, then checks the sign-in", async () => {
    const dir = tmp("fake-cli-");
    const log = join(dir, "calls.log");
    const script = join(dir, "fake-shopify.js");
    const bin = process.platform === "win32" ? join(dir, "shopify.cmd") : join(dir, "shopify");
    if (process.platform === "win32") writeFileSync(bin, `@node "${script}" %*\r\n`);
    writeFileSync(
      process.platform === "win32" ? script : bin,
      `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[3] === "execute") console.log(JSON.stringify({ data: { shop: { name: "Demo Shop" } } }));
`,
    );
    chmodSync(bin, 0o755);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => void lines.push(a.join(" ")));
    try {
      const code = await runCli(["connect", "demo-shop", "--writes"], { SHOPIFY_CLI_BIN: bin, SHOPIFY_STORES: "{}" } as any);
      expect(code).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(calls[0]!.slice(0, 4)).toEqual(["store", "auth", "--store", "demo-shop.myshopify.com"]);
    expect(arg(calls[0]!, "--scopes")).toContain("write_metaobjects");
    expect(calls[1]!.slice(0, 2)).toEqual(["store", "execute"]);
    expect(lines.join("\n")).toContain("Connected to Demo Shop (demo-shop.myshopify.com)");
    expect(lines.join("\n")).toContain('"auth": "shopify-cli", "allowWrites": true');
  });
});
