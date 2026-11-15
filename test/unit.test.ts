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
