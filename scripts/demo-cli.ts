/**
 * Runs the real CLI against two sample in-memory stores and records what it prints,
 * plus the folder an export produces. Used for docs/images/cli.png and config-as-code.png.
 *
 *   npx tsx scripts/demo-cli.ts > docs/demo-cli.json
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runCli } from "../src/cli.js";
import { StoreRegistry, type StoreConfig } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { PlanStore } from "../src/plan.js";
import { FakeShop } from "../test/fakeShop.js";

process.env.SYNC_AUDIT_LOG = join(mkdtempSync(join(tmpdir(), "demo-")), "audit.log");

const page = (id: string, handle: string, title: string, body: string) => ({ id, handle, title, body, isPublished: true, templateSuffix: null });
const collection = (id: string, handle: string, title: string, smart: boolean) => ({
  id,
  handle,
  title,
  descriptionHtml: "",
  sortOrder: "BEST_SELLING",
  templateSuffix: null,
  seo: { title: null, description: null },
  ruleSet: smart ? { appliedDisjunctively: false, rules: [{ column: "TAG", relation: "EQUALS", condition: handle, conditionObject: null }] } : null,
});

const dev = new FakeShop(FakeShop.config("dev"), {
  shopLocales: [
    { locale: "en", primary: true },
    { locale: "fr", primary: false },
  ],
  pages: [page("gid://shopify/Page/1", "shipping", "Shipping", "<p>Free delivery from 80 EUR.</p>"), page("gid://shopify/Page/2", "care-guide", "Care guide", "<p>Wash cold.</p>")],
  collections: [collection("gid://shopify/Collection/1", "linen", "Linen", true), collection("gid://shopify/Collection/2", "new-in", "New in", true)],
  shopPolicies: [{ id: "gid://shopify/ShopPolicy/1", type: "REFUND_POLICY", body: "<p>Returns within 30 days.</p>" }],
  translations: { "gid://shopify/Page/1": { fr: { title: "Livraison", body_html: "<p>Livraison offerte dès 80 EUR.</p>" } } },
  redirects: [{ id: "gid://shopify/UrlRedirect/1", path: "/summer-sale", target: "/collections/linen" }],
  themes: [
    {
      id: "gid://shopify/OnlineStoreTheme/1",
      name: "Horizon",
      role: "MAIN",
      files: {
        "templates/product.json": JSON.stringify({ sections: { main: { type: "product-information", settings: { gap: 48, enable_sticky_add_to_cart: true } } } }),
        "config/settings_data.json": JSON.stringify({ current: { cart_type: "drawer", badge_position: "top-right" } }),
        "templates/page.care-guide.json": JSON.stringify({ sections: {} }),
      },
    },
  ],
});

const eu = new FakeShop(FakeShop.config("eu", { protected: true }), {
  shopLocales: [
    { locale: "en", primary: true },
    { locale: "fr", primary: false },
  ],
  pages: [page("gid://shopify/Page/91", "shipping", "Shipping", "<p>Free delivery from 100 EUR.</p>")],
  translatableContent: { "gid://shopify/Page/91": [{ key: "title", digest: "a" }, { key: "body_html", digest: "b" }] },
  collections: [collection("gid://shopify/Collection/91", "linen", "Linen", true)],
  shopPolicies: [{ id: "gid://shopify/ShopPolicy/91", type: "REFUND_POLICY", body: "<p>Returns within 14 days.</p>" }],
  themes: [
    {
      id: "gid://shopify/OnlineStoreTheme/9",
      name: "Horizon",
      role: "MAIN",
      files: {
        "templates/product.json": JSON.stringify({ sections: { main: { type: "product-information", settings: { gap: 32, enable_sticky_add_to_cart: true } } } }),
        "config/settings_data.json": JSON.stringify({ current: { cart_type: "page", badge_position: "top-right" } }),
      },
    },
  ],
});

const shops: Record<string, FakeShop> = { dev, eu };
const engine = new Engine(new StoreRegistry([dev.store, eu.store]), new PlanStore(mkdtempSync(join(tmpdir(), "demo-plans-"))), (s: StoreConfig) => shops[s.alias]!);

async function capture(args: string[]): Promise<{ cmd: string; output: string; exit: number }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  const exit = await runCli(args, {}, engine);
  console.log = log;
  return { cmd: `shopify-store-sync-mcp ${args.join(" ")}`, output: lines.join("\n"), exit };
}

const resources = "pages,collections,shop_policies,redirects,translations";
const diff = await capture(["diff", "dev", "eu", "--resources", resources]);
const plan = await capture(["plan", "dev", "eu", "--resources", resources]);
const themes = await capture(["themes", "dev", "eu"]);

const dir = join(mkdtempSync(join(tmpdir(), "demo-export-")), "store-config");
const exp = await capture(["export", "dev", dir, "--resources", resources]);
const walk = (d: string): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [relative(dir, join(d, e.name))])).sort();
const tree = walk(dir);
const sample = readFileSync(join(dir, "translations", "fr_Page_shipping.json"), "utf8");

console.log(
  JSON.stringify(
    {
      diff,
      plan: { ...plan, output: plan.output.replace(/[0-9a-f-]{36}/g, "<plan-id>") },
      themes,
      export: { ...exp, cmd: exp.cmd.replace(dir, "./store-config"), output: exp.output.replace(dir, "./store-config") },
      tree,
      sample,
    },
    null,
    2,
  ),
);
