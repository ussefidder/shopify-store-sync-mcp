#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { COMMANDS, runCli } from "./cli.js";
import { loadStores, StoreRegistry } from "./config.js";
import { createServer, VERSION } from "./server.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    process.exitCode = await runCli(["help"]);
    return;
  }
  // A known command runs the CLI; no arguments starts the MCP server on stdio.
  if (args[0] && (COMMANDS as readonly string[]).includes(args[0])) {
    process.exitCode = await runCli(args);
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
