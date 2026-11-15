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
  // Anything else that isn't a flag is a typo. Starting the server here would look like a hang.
  if (args[0] && !args[0].startsWith("-")) {
    console.error(`unknown command "${args[0]}". Commands: ${COMMANDS.join(", ")}. Run with --help for usage; run with no arguments to start the MCP server.`);
    process.exitCode = 1;
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
