import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadStores, parseStores, StoreRegistry } from "../src/config.js";
import { diffItems, diffValues, matchesFilter, stableStringify } from "../src/diff.js";
import { collectGids, mapStrings, nodeToRef } from "../src/refs.js";
import { normalizeMenuItem } from "../src/resources/menus.js";
import { ShopifyAdminClient, type FetchLike } from "../src/shopify/client.js";

describe("config", () => {
  it("expands env: references and applies safe defaults", () => {
    const [s] = parseStores({ dev: { domain: "dev-shop.myshopify.com", accessToken: "env:DEV_TOKEN" } }, { DEV_TOKEN: "shpat_x" });
    expect(s).toMatchObject({ alias: "dev", accessToken: "shpat_x", allowWrites: false, protected: false, apiVersion: "2026-10" });
  });

  it("rejects bad domains, missing credentials and unset env vars", () => {
    expect(() => parseStores({ a: { domain: "example.com", accessToken: "x" } })).toThrow(/myshopify/);
    expect(() => parseStores({ a: { domain: "a.myshopify.com" } })).toThrow(/accessToken, or clientId/);
    expect(() => parseStores({ a: { domain: "a.myshopify.com", accessToken: "env:NOPE" } }, {})).toThrow(/NOPE is not set/);
    expect(() => parseStores({ "bad alias": { domain: "a.myshopify.com", accessToken: "x" } })).toThrow(/invalid store alias/);
  });

  it("loads from SHOPIFY_STORES, then a stores file, then single-store env vars", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    writeFileSync(join(dir, "stores.json"), JSON.stringify({ stores: { file: { domain: "f.myshopify.com", accessToken: "t" } } }));

    const inline = { SHOPIFY_STORES: JSON.stringify({ inline: { domain: "i.myshopify.com", accessToken: "t" } }) };
    expect(loadStores(inline, dir).map((s) => s.alias)).toEqual(["inline"]);
    expect(loadStores({}, dir).map((s) => s.alias)).toEqual(["file"]);
    const single = loadStores({ SHOPIFY_STORE_DOMAIN: "s.myshopify.com", SHOPIFY_CLIENT_ID: "id", SHOPIFY_CLIENT_SECRET: "sec" }, tmpdir());
    expect(single).toMatchObject([{ alias: "default", clientId: "id", allowWrites: false }]);
    expect(loadStores({}, mkdtempSync(join(tmpdir(), "empty-")))).toEqual([]);

    // Windows PowerShell and Notepad save UTF-8 with a byte order mark
    const bom = mkdtempSync(join(tmpdir(), "bom-"));
    writeFileSync(join(bom, "stores.json"), "﻿" + JSON.stringify({ stores: { win: { domain: "w.myshopify.com", auth: "shopify-cli" } } }));
    expect(loadStores({}, bom).map((s) => s.alias)).toEqual(["win"]);
  });

  it("names known stores when an alias is wrong", () => {
    const reg = new StoreRegistry(parseStores({ dev: { domain: "d.myshopify.com", accessToken: "t" } }));
    expect(() => reg.get("prod")).toThrow(/known: dev/);
  });
});

describe("refs", () => {
  it("finds GIDs inside JSON-encoded list values", () => {
    const value = { a: "gid://shopify/Product/1", b: '["gid://shopify/Product/2","gid://shopify/Collection/3"]', c: "plain" };
    expect([...collectGids(value)].sort()).toEqual(["gid://shopify/Collection/3", "gid://shopify/Product/1", "gid://shopify/Product/2"]);
    expect(mapStrings(value, (s) => s.replace("gid://shopify/", "x/"))).toEqual({
      a: "x/Product/1",
      b: '["x/Product/2","x/Collection/3"]',
      c: "plain",
    });
  });

  it("maps node types to portable refs", () => {
    expect(nodeToRef({ __typename: "Metaobject", id: "g", type: "faq", handle: "a" })).toBe("shopify://Metaobject/faq/a");
    expect(nodeToRef({ __typename: "Collection", id: "g", handle: "sale" })).toBe("shopify://Collection/sale");
    expect(nodeToRef({ __typename: "MediaImage", id: "g" })).toBeUndefined();
  });
});

describe("diff", () => {
  it("matches keyed arrays by key, not position", () => {
    const a = { fields: [{ key: "x", type: "a" }, { key: "y", type: "b" }] };
    const b = { fields: [{ key: "y", type: "b" }, { key: "x", type: "z" }] };
    expect(diffValues(a, b)).toEqual([{ path: "fields[x].type", source: "a", target: "z" }]);
  });

  it("ignores values made only of refs that can't be mapped across stores", () => {
    expect(diffValues({ image: "shopify://unresolved/MediaImage/1" }, {})).toEqual([]);
    expect(diffValues({ p: "shopify://Product/a" }, {})).toHaveLength(1);
  });

  it("filters keys with globs", () => {
    expect(matchesFilter("PRODUCT.custom.size", { include: ["PRODUCT.custom.*"] })).toBe(true);
    expect(matchesFilter("ORDER.custom.size", { include: ["PRODUCT.*"] })).toBe(false);
    expect(matchesFilter("faq/draft-1", { exclude: ["faq/draft-*"] })).toBe(false);
    const d = diffItems("pages", [{ key: "a", id: "1", data: {} }, { key: "b", id: "2", data: {} }], [], { exclude: ["b"] });
    expect(d.onlyInSource.map((i) => i.key)).toEqual(["a"]);
  });

  it("is insensitive to object key order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe("menus", () => {
  it("drops store-specific URLs from items that point at a resource", () => {
    expect(
      normalizeMenuItem({ title: "Shop", type: "COLLECTION", url: "https://a.myshopify.com/collections/all", resourceId: "gid://shopify/Collection/1", tags: [] }),
    ).toEqual({ title: "Shop", type: "COLLECTION", resourceId: "gid://shopify/Collection/1" });
  });
});

describe("ShopifyAdminClient", () => {
  const store = parseStores({ s: { domain: "s.myshopify.com", clientId: "id", clientSecret: "secret" } })[0]!;

  function fakeFetch(responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fn: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      const r = responses.shift() ?? { body: { data: {} } };
      const status = r.status ?? 200;
      return {
        ok: status < 400,
        status,
        headers: { get: (n: string) => r.headers?.[n] ?? null },
        json: async () => r.body,
        text: async () => JSON.stringify(r.body),
      };
    };
    return { fn, calls };
  }

  it("gets a client-credentials token, then retries throttled queries", async () => {
    const { fn, calls } = fakeFetch([
      { body: { access_token: "tok", expires_in: 86399 } },
      {
        body: {
          errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
          extensions: { cost: { requestedQueryCost: 10, throttleStatus: { currentlyAvailable: 0, restoreRate: 1000 } } },
        },
      },
      { body: { data: { shop: { name: "S" } } } },
    ]);
    const client = new ShopifyAdminClient(store, fn);
    await expect(client.request("query { shop { name } }")).resolves.toEqual({ shop: { name: "S" } });
    expect(calls[0]!.url).toBe("https://s.myshopify.com/admin/oauth/access_token");
    expect(calls[0]!.body).toContain("grant_type=client_credentials");
    expect(calls[2]!.headers["X-Shopify-Access-Token"]).toBe("tok");
    expect(calls[2]!.url).toBe("https://s.myshopify.com/admin/api/2026-10/graphql.json");
  });

  it("explains why a token request was refused", async () => {
    const html = "<html><head><title>400 - Oauth error app_not_installed</title></head></html>";
    const fn: FetchLike = async () => ({ ok: false, status: 400, headers: { get: () => null }, json: async () => ({}), text: async () => html });
    await expect(new ShopifyAdminClient(store, fn).request("query { shop { name } }")).rejects.toThrow(
      "token request for s.myshopify.com failed with HTTP 400: the app isn't installed on this store yet",
    );
  });

  it("refreshes the token once on 401", async () => {
    const { fn, calls } = fakeFetch([
      { body: { access_token: "old", expires_in: 86399 } },
      { status: 401, body: {} },
      { body: { access_token: "new", expires_in: 86399 } },
      { body: { data: { ok: true } } },
    ]);
    await expect(new ShopifyAdminClient(store, fn).request("query { ok }")).resolves.toEqual({ ok: true });
    expect(calls[3]!.headers["X-Shopify-Access-Token"]).toBe("new");
  });

  it("surfaces GraphQL errors", async () => {
    const { fn } = fakeFetch([{ body: { access_token: "t" } }, { body: { errors: [{ message: "Field 'x' doesn't exist" }] } }]);
    await expect(new ShopifyAdminClient(store, fn).request("query { x }")).rejects.toThrow(/Field 'x' doesn't exist/);
  });
});

describe("bulk reads", async () => {
  const { bulkQuery } = await import("../src/shopify/bulk.js");
  const { nodesFromBulk } = await import("../src/resources/products.js");
  const store = { alias: "s", domain: "s.myshopify.com" } as any;

  it("starts the operation, polls until done and parses the file", async () => {
    const statuses = ["RUNNING", "COMPLETED"];
    const client = {
      store,
      request: async (q: string) =>
        /bulkOperationRunQuery/.test(q)
          ? { bulkOperationRunQuery: { bulkOperation: { id: "gid://shopify/BulkOperation/1" }, userErrors: [] } }
          : { node: { status: statuses.shift(), errorCode: null, objectCount: "2", url: "https://files/x.jsonl", partialDataUrl: null } },
    };
    const rows = await bulkQuery(client as any, "{ products { edges { node { id } } } }", {
      wait: async () => {},
      download: async () => '{"id":"gid://shopify/Product/1"}\n{"id":"gid://shopify/Product/2"}\n',
    });
    expect(rows.map((r) => r.id)).toEqual(["gid://shopify/Product/1", "gid://shopify/Product/2"]);
  });

  it("says why when Shopify fails the operation", async () => {
    const client = {
      store,
      request: async (q: string) =>
        /bulkOperationRunQuery/.test(q)
          ? { bulkOperationRunQuery: { bulkOperation: { id: "b" }, userErrors: [] } }
          : { node: { status: "FAILED", errorCode: "ACCESS_DENIED", objectCount: "0", url: null, partialDataUrl: null } },
    };
    await expect(bulkQuery(client as any, "{}", { wait: async () => {} })).rejects.toThrow(/failed \(ACCESS_DENIED\)/);
  });

  it("puts variants and media back under their product", () => {
    const nodes = nodesFromBulk([
      { id: "gid://shopify/Product/1", handle: "a" },
      { id: "gid://shopify/ProductVariant/11", __parentId: "gid://shopify/Product/1" },
      { id: "gid://shopify/MediaImage/12", __parentId: "gid://shopify/Product/1" },
      { id: "gid://shopify/Product/2", handle: "b" },
      { id: "gid://shopify/ProductVariant/21", __parentId: "gid://shopify/Product/2" },
    ]);
    expect(nodes.map((n: any) => [n.handle, n.variants.nodes.length, n.media.nodes.length])).toEqual([
      ["a", 1, 1],
      ["b", 1, 0],
    ]);
  });
});

describe("bulk writes in parts", async () => {
  const { bulkMutation, bulkIO } = await import("../src/shopify/bulk.js");
  it("splits a big write into a few operations at once and keeps results in line order", async () => {
    const files = new Map<string, string>();
    const ops = new Map<string, string>();
    let n = 0;
    bulkIO.wait = async () => {};
    bulkIO.upload = async (_u, form) => void files.set(String(form.get("key")), await (form.get("file") as Blob).text());
    bulkIO.download = async (url) => ops.get(url) ?? "";
    const client = {
      store: { alias: "s", domain: "s.myshopify.com" } as any,
      request: async (q: string, v: any) => {
        if (q.includes("stagedUploadsCreate")) return { stagedUploadsCreate: { stagedTargets: [{ url: "u", parameters: [{ name: "key", value: `k${++n}` }] }], userErrors: [] } };
        if (q.includes("bulkOperationRunMutation")) {
          const lines = files.get(v.stagedUploadPath)!.split("\n");
          ops.set(`dl-${v.stagedUploadPath}`, lines.map((l, i) => JSON.stringify({ data: { echo: JSON.parse(l).x }, __lineNumber: i })).join("\n"));
          return { bulkOperationRunMutation: { bulkOperation: { id: v.stagedUploadPath }, userErrors: [] } };
        }
        return { node: { status: "COMPLETED", errorCode: null, objectCount: "0", url: `dl-${v.id}`, partialDataUrl: null } };
      },
    };
    const lines = Array.from({ length: 250 }, (_, i) => ({ x: i }));
    const res = await bulkMutation(client as any, "mutation M($x: Int) { echo }", lines);
    expect(n).toBe(3);
    expect(res.map((r) => r.data?.echo)).toEqual(lines.map((l) => l.x));
  });

  it("starts the next part as soon as one finishes when the store runs fewer at once, and reports each part", async () => {
    const files = new Map<string, string>();
    const running = new Set<string>();
    const polls = new Map<string, number>();
    let n = 0;
    let most = 0;
    let started = 0;
    let refused = 0;
    bulkIO.wait = async () => {};
    bulkIO.upload = async (_u, form) => void files.set(String(form.get("key")), await (form.get("file") as Blob).text());
    bulkIO.download = async (url) =>
      files
        .get(url)!
        .split("\n")
        .map((l, i) => JSON.stringify({ data: { echo: JSON.parse(l).x }, __lineNumber: i }))
        .join("\n");
    const client = {
      store: { alias: "s", domain: "s.myshopify.com" } as any,
      request: async (q: string, v: any) => {
        if (q.includes("stagedUploadsCreate")) return { stagedUploadsCreate: { stagedTargets: [{ url: "u", parameters: [{ name: "key", value: `k${++n}` }] }], userErrors: [] } };
        if (q.includes("bulkOperationRunMutation")) {
          if (running.size >= 2) refused++;
          if (running.size >= 2) return { bulkOperationRunMutation: { bulkOperation: null, userErrors: [{ message: "A bulk mutation is already in progress, over the limit" }] } };
          running.add(v.stagedUploadPath);
          started++;
          most = Math.max(most, running.size);
          return { bulkOperationRunMutation: { bulkOperation: { id: v.stagedUploadPath }, userErrors: [] } };
        }
        // Operations keep running until the store has refused one for being over its limit.
        const seen = (polls.get(v.id) ?? 0) + 1;
        polls.set(v.id, seen);
        if (seen < 2 || (refused === 0 && started < 5)) return { node: { status: "RUNNING", errorCode: null, objectCount: "40", url: null, partialDataUrl: null } };
        running.delete(v.id);
        return { node: { status: "COMPLETED", errorCode: null, objectCount: "100", url: v.id, partialDataUrl: null } };
      },
    };
    const lines = Array.from({ length: 500 }, (_, i) => ({ x: i }));
    const parts: [number, number, number, number][] = [];
    const progress: number[] = [];
    const res = await bulkMutation(client as any, "mutation M($x: Int) { echo }", lines, {
      onPart: (part, of, start, rows) => parts.push([part, of, start, rows.length]),
      onProgress: (w) => progress.push(w),
    });
    expect(most).toBe(2);
    expect(refused).toBeGreaterThan(0);
    expect(res.map((r) => r.data?.echo)).toEqual(lines.map((l) => l.x));
    expect(parts.map((p) => p[0]).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(parts.find((p) => p[0] === 3)).toEqual([3, 5, 200, 100]);
    expect(progress.at(-1)).toBe(500);
    expect(progress.some((w) => w > 0 && w < 500)).toBe(true);
  });
});

describe("apply_status", async () => {
  const { ApplyJobs, jobStatus } = await import("../src/jobs.js");
  it("counts each resource type, what's left and the time remaining", async () => {
    let clock = 0;
    const plan = {
      id: "p1",
      target: { alias: "dst", domain: "dst.myshopify.com" },
      ops: Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, kind: i < 6 ? "products" : "metafields", key: `k${i}`, action: "create" })),
    } as any;
    let finish!: () => void;
    const jobs = new ApplyJobs();
    const job = jobs.start(
      plan,
      {},
      (opts) =>
        new Promise((resolve) => {
          opts.onPhase?.("writing products");
          clock = 60_000;
          for (let i = 1; i <= 4; i++) opts.onResult?.({ seq: i, kind: "products", key: `k${i - 1}`, outcome: i === 2 ? "failed" : "created", message: i === 2 ? "bad" : undefined });
          clock = 120_000;
          finish = () => resolve({ plan: { ...plan, status: "partially_applied" }, results: [] });
        }),
      () => clock,
    );
    const s = jobStatus(job, 120_000);
    expect(s).toMatchObject({ state: "running", phase: "writing products", totals: { created: 3, failed: 1, left: 6 } });
    expect(s.byResource.products).toMatchObject({ total: 6, created: 3, failed: 1, left: 2 });
    expect(s.byResource.metafields).toMatchObject({ total: 4, left: 4 });
    // 4 written in the minute since the first write: 6 left take about a minute and a half.
    expect(s.remaining).toBe("2 min");
    expect(s.failures).toEqual([{ seq: 2, kind: "products", key: "k1", message: "bad" }]);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(jobStatus(job, 200_000)).toMatchObject({ state: "done", planStatus: "partially_applied", remaining: undefined });
    expect(jobs.running("p1")).toBe(false);
  });
});

describe("short reports for big diffs and plans", async () => {
  const { diffMarkdown, planMarkdown } = await import("../src/report.js");
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `p-${i}`, id: `gid://shopify/Product/${i}`, data: {} }));
  it("lists a limited number of items per section, with how many more there are", () => {
    const diff = { kind: "products" as const, onlyInSource: items(300), onlyInTarget: items(3), changed: [], identical: 0 };
    const md = diffMarkdown({ alias: "a", domain: "a.myshopify.com" }, { alias: "b", domain: "b.myshopify.com" }, [diff], [], undefined, 50);
    expect(md).toContain("**Only in a** (300)");
    expect(md).toContain("`p-49`");
    expect(md).not.toContain("`p-50`");
    expect(md).toContain("… and 250 more");
    // Without a limit (the command line), everything is listed.
    expect(diffMarkdown({ alias: "a", domain: "a.myshopify.com" }, { alias: "b", domain: "b.myshopify.com" }, [diff])).toContain("`p-299`");
  });

  it("counts a plan's steps per resource type", () => {
    const ops = [
      ...Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, kind: "products", key: `p${i}`, action: "create", data: {} })),
      { seq: 6, kind: "metafields", key: "m", action: "update", data: {}, changes: [] },
    ];
    const plan = { id: "x", createdAt: "", expiresAt: "", source: { alias: "a", domain: "a" }, target: { alias: "b", domain: "b" }, kinds: [], ops, onlyInTarget: [], skipped: [], warnings: [], files: {}, status: "pending" } as any;
    const md = planMarkdown(plan, 2);
    expect(md).toContain("| products | 5 | 0 | 0 |");
    expect(md).toContain("| metafields | 0 | 1 | 0 |");
    expect(md).toContain("4 more steps");
  });
});
