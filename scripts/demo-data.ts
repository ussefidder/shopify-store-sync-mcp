/**
 * Runs the real MCP server (over the MCP protocol, in memory) against two sample
 * in-memory stores and prints what diff_stores, plan_sync and apply_plan return.
 * Used to produce the images in docs/images so they show genuine output.
 *
 *   npx tsx scripts/demo-data.ts > docs/demo-output.json
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StoreRegistry, type StoreConfig } from "../src/config.js";
import { PlanStore } from "../src/plan.js";
import { createServer } from "../src/server.js";
import { takeSnapshot } from "../src/snapshot.js";
import { FakeShop } from "../test/fakeShop.js";

process.env.SYNC_AUDIT_LOG = join(mkdtempSync(join(tmpdir(), "demo-")), "audit.log");

const def = (id: string, ns: string, key: string, name: string, type: string) => ({
  id,
  name,
  namespace: ns,
  key,
  description: null,
  ownerType: "PRODUCT",
  pinnedPosition: null,
  type: { name: type },
  access: { storefront: "PUBLIC_READ", customerAccount: "NONE" },
  capabilities: { adminFilterable: { enabled: false }, smartCollectionCondition: { enabled: false }, uniqueValues: { enabled: false } },
  validations: [],
});
const field = (key: string, type: string, required = false, validations: { name: string; value: string }[] = []) => ({
  key,
  name: key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
  description: null,
  required,
  type: { name: type },
  validations,
  capabilities: { adminFilterable: { enabled: false } },
});
const entry = (id: string, type: string, handle: string, values: Record<string, string>) => ({
  id,
  type,
  handle,
  fields: Object.entries(values).map(([key, value]) => ({ key, value })),
  capabilities: { publishable: { status: "ACTIVE" } },
});
const sizeGuideDef = (id: string) => ({
  id,
  type: "size_guide",
  name: "Size guide",
  description: null,
  displayNameKey: "title",
  access: { storefront: "PUBLIC_READ", customerAccount: "NONE" },
  capabilities: { publishable: { enabled: true }, translatable: { enabled: true }, renderable: { enabled: false }, onlineStore: { enabled: false, data: null } },
  fieldDefinitions: [field("title", "single_line_text_field", true), field("chart", "json"), field("product", "product_reference")],
});
const page = (id: string, handle: string, title: string, body: string) => ({ id, handle, title, body, isPublished: true, templateSuffix: null });

const dev = new FakeShop(FakeShop.config("dev", { label: "Development" }), {
  products: [{ id: "gid://shopify/Product/101", handle: "linen-shirt" }],
  collections: [{ id: "gid://shopify/Collection/201", handle: "new-in" }],
  metafieldDefinitions: [
    def("gid://shopify/MetafieldDefinition/1", "custom", "material", "Material", "single_line_text_field"),
    def("gid://shopify/MetafieldDefinition/2", "custom", "care_guide", "Care instructions", "multi_line_text_field"),
    def("gid://shopify/MetafieldDefinition/3", "custom", "size_chart", "Size chart", "json"),
  ],
  metaobjectDefinitions: [sizeGuideDef("gid://shopify/MetaobjectDefinition/1")],
  metaobjects: [
    entry("gid://shopify/Metaobject/1", "size_guide", "shirts", { title: "Shirts", chart: '{"S":"36","M":"38","L":"40"}', product: "gid://shopify/Product/101" }),
    entry("gid://shopify/Metaobject/2", "size_guide", "trousers", { title: "Trousers", chart: '{"S":"38","M":"40","L":"42"}' }),
  ],
  pages: [page("gid://shopify/Page/1", "shipping", "Shipping", "<p>Free delivery from 80 EUR, 2 to 4 days.</p>")],
  menus: [
    {
      id: "gid://shopify/Menu/1",
      handle: "main-menu",
      title: "Main menu",
      items: [
        { title: "New in", type: "COLLECTION", url: "/collections/new-in", resourceId: "gid://shopify/Collection/201", tags: [], items: [] },
        { title: "Shipping", type: "PAGE", url: "/pages/shipping", resourceId: "gid://shopify/Page/1", tags: [], items: [] },
      ],
    },
  ],
  redirects: [
    { id: "gid://shopify/UrlRedirect/1", path: "/summer-sale", target: "/collections/new-in" },
    { id: "gid://shopify/UrlRedirect/2", path: "/old-shirt", target: "/products/linen-shirt" },
  ],
});

const eu = new FakeShop(FakeShop.config("eu", { label: "EU production", protected: true }), {
  products: [{ id: "gid://shopify/Product/9101", handle: "linen-shirt" }],
  collections: [{ id: "gid://shopify/Collection/9201", handle: "new-in" }],
  metafieldDefinitions: [
    def("gid://shopify/MetafieldDefinition/91", "custom", "care_guide", "Care", "multi_line_text_field"),
    def("gid://shopify/MetafieldDefinition/92", "custom", "size_chart", "Size chart", "single_line_text_field"),
  ],
  pages: [page("gid://shopify/Page/91", "shipping", "Shipping", "<p>Free delivery from 100 EUR, 3 to 5 days.</p>")],
  menus: [
    {
      id: "gid://shopify/Menu/91",
      handle: "main-menu",
      title: "Main menu",
      items: [{ title: "New in", type: "COLLECTION", url: "/collections/new-in", resourceId: "gid://shopify/Collection/9201", tags: [], items: [] }],
    },
  ],
  redirects: [{ id: "gid://shopify/UrlRedirect/91", path: "/legacy-home", target: "/" }],
});

const shops: Record<string, FakeShop> = { dev, eu };
const server = createServer({
  registry: new StoreRegistry([dev.store, eu.store]),
  plans: new PlanStore(mkdtempSync(join(tmpdir(), "demo-plans-"))),
  clientFactory: (s: StoreConfig) => shops[s.alias]!,
});
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "demo", version: "0" });
await Promise.all([server.connect(a), client.connect(b)]);

async function call(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = res.content[0]!.text;
  return res.isError ? { error: text } : JSON.parse(text);
}

// Before any write: how the eu menu looks, and how dev's references read in portable form.
const menuBefore = eu.state.menus[0].items.map((i: { title: string }) => i.title);
const devPortable = await takeSnapshot(dev, ["metaobjects", "menus"]);

const diff = await call("diff_stores", { source: "dev", target: "eu" });
const plan = await call("plan_sync", { source: "dev", target: "eu" });
const refused = await call("apply_plan", { plan_id: plan.plan_id });
const applied = await call("apply_plan", { plan_id: plan.plan_id, confirm: "eu.myshopify.com" });
const again = await call("plan_sync", { source: "dev", target: "eu" });
const menuAfter = eu.state.menus[0].items.map((i: { title: string; resourceId: string | null }) => [i.title, i.resourceId]);

// Follow two references from dev, through the portable form, to the IDs written in eu.
const shirtsDev = dev.state.metaobjects.find((o: { handle: string }) => o.handle === "shirts");
const shirtsEu = eu.state.metaobjects.find((o: { handle: string }) => o.handle === "shirts");
const shirtsPortable = devPortable.resources.metaobjects!.items.find((i) => i.key === "size_guide/shirts")!.data.fields as Record<string, string>;
const menuPortable = devPortable.resources.menus!.items[0]!.data.items as { title: string; resourceId?: string }[];
const trace = [
  {
    what: "size_guide/shirts · product field",
    source: shirtsDev.fields.find((f: { key: string }) => f.key === "product").value,
    portable: shirtsPortable.product,
    target: shirtsEu.fields.find((f: { key: string }) => f.key === "product").value,
  },
  {
    what: "main-menu · Shipping link",
    source: dev.state.menus[0].items[1].resourceId,
    portable: menuPortable.find((i) => i.title === "Shipping")!.resourceId,
    target: eu.state.menus[0].items.find((i: { title: string }) => i.title === "Shipping").resourceId,
  },
];

console.log(JSON.stringify({ diff, plan, refused, applied, replan: again.totals, menuBefore, menuAfter, trace }, null, 2));
process.exit(0);
