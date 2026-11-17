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

  it("keeps waiting through a few failed status checks and downloads: the operation runs on Shopify's side anyway", async () => {
    let polls = 0;
    let downloads = 0;
    const client = {
      store,
      request: async (q: string) => {
        if (/bulkOperationRunQuery/.test(q)) return { bulkOperationRunQuery: { bulkOperation: { id: "b" }, userErrors: [] } };
        if (++polls <= 2) throw new Error("Shopify CLI gave no answer and was stopped");
        return { node: { status: "COMPLETED", errorCode: null, objectCount: "1", url: "https://files/x.jsonl", partialDataUrl: null } };
      },
    };
    const rows = await bulkQuery(client as any, "{}", {
      wait: async () => {},
      download: async () => {
        if (++downloads === 1) throw new Error("socket hang up");
        return '{"id":"1"}';
      },
    });
    expect(rows).toEqual([{ id: "1" }]);
    const dead = { store, request: async (q: string) => (/RunQuery/.test(q) ? { bulkOperationRunQuery: { bulkOperation: { id: "b" }, userErrors: [] } } : Promise.reject(new Error("offline"))) };
    await expect(bulkQuery(dead as any, "{}", { wait: async () => {} })).rejects.toThrow(/checking its status kept failing \(offline\)/);
  });

  it("waits as long as the operation keeps writing, and gives up only once it stops moving", async () => {
    const sleep = async () => new Promise<void>((r) => setTimeout(r, 3));
    let polls = 0;
    const moving = {
      store,
      request: async (q: string) =>
        /RunQuery/.test(q)
          ? { bulkOperationRunQuery: { bulkOperation: { id: "b" }, userErrors: [] } }
          : ++polls < 6
            ? { node: { status: "RUNNING", errorCode: null, objectCount: String(polls * 10), url: null, partialDataUrl: null } }
            : { node: { status: "COMPLETED", errorCode: null, objectCount: "60", url: "u", partialDataUrl: null } },
    };
    await expect(bulkQuery(moving as any, "{}", { wait: sleep, timeoutMs: 1, download: async () => '{"id":"1"}' })).resolves.toEqual([{ id: "1" }]);
    const stuck = {
      store,
      request: async (q: string) =>
        /RunQuery/.test(q)
          ? { bulkOperationRunQuery: { bulkOperation: { id: "b" }, userErrors: [] } }
          : { node: { status: "RUNNING", errorCode: null, objectCount: "7", url: null, partialDataUrl: null } },
    };
    await expect(bulkQuery(stuck as any, "{}", { wait: sleep, timeoutMs: 1 })).rejects.toThrow(/has written nothing more/);
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

describe("cancelling a bulk write", async () => {
  const { bulkMutation, bulkIO } = await import("../src/shopify/bulk.js");
  it("stops the operations on Shopify's side and keeps the results of the lines already written", async () => {
    const abort = new AbortController();
    const cancelled: string[] = [];
    let n = 0;
    bulkIO.wait = async () => {};
    bulkIO.upload = async () => {};
    bulkIO.download = async () => [0, 1, 2].map((i) => JSON.stringify({ data: { echo: i }, __lineNumber: i })).join("\n");
    const client = {
      store: { alias: "s", domain: "s.myshopify.com" } as any,
      request: async (q: string, v: any) => {
        if (q.includes("stagedUploadsCreate")) return { stagedUploadsCreate: { stagedTargets: [{ url: "u", parameters: [{ name: "key", value: `k${++n}` }] }], userErrors: [] } };
        if (q.includes("bulkOperationRunMutation")) return { bulkOperationRunMutation: { bulkOperation: { id: v.stagedUploadPath }, userErrors: [] } };
        if (q.includes("bulkOperationCancel")) {
          cancelled.push(v.id);
          return { bulkOperationCancel: { bulkOperation: { id: v.id, status: "CANCELING" }, userErrors: [] } };
        }
        if (cancelled.includes(v.id)) return { node: { status: "CANCELED", errorCode: null, objectCount: "3", url: null, partialDataUrl: "partial" } };
        abort.abort();
        return { node: { status: "RUNNING", errorCode: null, objectCount: "3", url: null, partialDataUrl: null } };
      },
    };
    const started: string[] = [];
    const res = await bulkMutation(client as any, "mutation M($x: Int) { echo }", Array.from({ length: 10 }, (_, i) => ({ x: i })), { signal: abort.signal, onStart: (id) => started.push(id) });
    expect(cancelled).toEqual(started);
    expect(res.slice(0, 3).map((r) => r.data?.echo)).toEqual([0, 1, 2]);
    expect(res.slice(3).every((r) => r.unknown && r.errors?.[0]?.message === "not written: the apply was cancelled")).toBe(true);
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
    expect(s.failureReasons).toEqual([{ kind: "products", reason: "bad", count: 1, examples: ["k1"], firstMessage: "bad" }]);
    expect(jobStatus(job, 120_000, 20, "metafields").failures).toEqual([]);
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

describe("decimals written two ways", async () => {
  const { diffItems } = await import("../src/diff.js");
  const mf = (value: string, type = "number_decimal") => [{ key: "PRODUCT/tee/custom.w", id: "x", data: { owner: "x", namespace: "custom", key: "w", type, value } }];
  it("treats 0.40 and 0.4 as the same decimal metafield value, but not as the same text", () => {
    expect(diffItems("metafields", mf("0.40"), mf("0.4")).identical).toBe(1);
    expect(diffItems("metafields", mf("[\"1.50\",\"2\"]", "list.number_decimal"), mf("[\"1.5\",\"2.0\"]", "list.number_decimal")).identical).toBe(1);
    expect(diffItems("metafields", mf("0.5"), mf("0.4")).changed).toHaveLength(1);
    expect(diffItems("metafields", mf("0.40", "single_line_text_field"), mf("0.4", "single_line_text_field")).changed).toHaveLength(1);
  });
});

describe("snapshot folders read like a store", async () => {
  const { applyView } = await import("../src/snapshot.js");
  const product = { handle: "tee", variants: [{ options: { Size: "M" }, sku: "T-M", price: "37", inventory: { Shop: 27 } }] };
  it("leaves prices and stock out unless asked for", () => {
    expect(applyView("products", product, {}).variants).toEqual([{ options: { Size: "M" }, sku: "T-M" }]);
    expect(applyView("products", product, { prices: true, inventory: true }).variants).toEqual(product.variants);
    expect(applyView("products", product, { inventory: true }).variants).toEqual([{ options: { Size: "M" }, sku: "T-M", inventory: { Shop: 27 } }]);
  });
});

describe("batched writes", async () => {
  const { batchedMutation, groupLines } = await import("../src/shopify/batch.js");
  const spec = { vars: "$x#: Int", field: "echo(x: $x#) { ok }", root: "echo", perRequest: 3 };
  it("groups by count and by weight", () => {
    const lines = [1, 1, 5, 1, 1, 1, 9].map((w) => ({ w }));
    const groups = groupLines(lines, { ...spec, perRequest: 3, weight: (l) => l.w as number, maxWeight: 6 });
    expect(groups.map((g) => [g.start, g.lines.length])).toEqual([[0, 2], [2, 2], [4, 2], [6, 1]]);
  });

  it("sends several writes per request, keeps results in line order and repeats only what is safe to repeat", async () => {
    const seen: string[] = [];
    let failures = 0;
    const client = {
      store: { alias: "s", domain: "s.myshopify.com" } as any,
      request: async (q: string, v: Record<string, number>) => {
        seen.push(q);
        if (v.x0 === 3 && failures++ === 0) throw new Error("network");
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [`w${k.slice(1)}`, { ok: x }]));
      },
    };
    const lines = Array.from({ length: 8 }, (_, i) => ({ x: i }));
    const starts: number[] = [];
    const res = await batchedMutation(client as any, { ...spec, idempotent: () => true }, lines, { concurrency: 2, onResults: (start) => starts.push(start) });
    expect(seen[0]).toBe("mutation Batch($x0: Int, $x1: Int, $x2: Int) { w0: echo(x: $x0) { ok } w1: echo(x: $x1) { ok } w2: echo(x: $x2) { ok } }");
    expect(res.map((r) => r.data?.echo.ok)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(starts.sort()).toEqual([0, 3, 6]);
    expect(seen).toHaveLength(4);
    // Not safe to repeat: the request isn't sent again and its writes are marked as unknown.
    failures = 0;
    const once = await batchedMutation(client as any, spec, lines, { concurrency: 1 });
    expect(once.slice(3, 6).every((r) => r.unknown && r.errors?.[0]?.message === "not written: network")).toBe(true);
    expect(once[6]!.data?.echo.ok).toBe(6);
  });

  it("starts nothing more once cancelled", async () => {
    const abort = new AbortController();
    const client = { store: {} as any, request: async (_q: string, v: Record<string, number>) => (abort.abort(), Object.fromEntries(Object.keys(v).map((k) => [`w${k.slice(1)}`, { ok: 1 }]))) };
    const res = await batchedMutation(client as any, spec, Array.from({ length: 9 }, (_, i) => ({ x: i })), { concurrency: 1, signal: abort.signal });
    expect(res.slice(0, 3).every((r) => r.data)).toBe(true);
    expect(res.slice(3).every((r) => r.errors?.[0]?.message === "not written: the apply was cancelled")).toBe(true);
  });
});
