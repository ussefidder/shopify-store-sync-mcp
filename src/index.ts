#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadStores, StoreRegistry } from "./config.js";
import { createServer, VERSION } from "./server.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`shopify-store-sync-mcp ${VERSION}

Diff and sync configuration between Shopify stores over MCP (stdio).

Configure stores with one of:
  SHOPIFY_STORES        inline JSON: {"dev": {"domain": "...", "accessToken": "..."}, ...}
  SHOPIFY_STORES_FILE   path to a stores.json file (default: ./stores.json)
  SHOPIFY_STORE_DOMAIN + SHOPIFY_ACCESS_TOKEN   single store, alias "default"

See https://github.com/ussefidder/shopify-store-sync-mcp#configuration`);
    return;
  }

  const stores = loadStores();
  if (!stores.length) {
    console.error("shopify-store-sync-mcp: no stores configured. Run with --help for setup.");
  }
  const server = createServer({ registry: new StoreRegistry(stores) });
  await server.connect(new StdioServerTransport());
  console.error(`shopify-store-sync-mcp ${VERSION} ready (${stores.length} store${stores.length === 1 ? "" : "s"})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
