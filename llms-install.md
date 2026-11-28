# Installing shopify-store-sync-mcp (guide for AI agents)

This MCP server compares and copies configuration between Shopify stores. It is published on npm as `shopify-store-sync-mcp` and runs with `npx`, so there is nothing to clone or build.

## What to ask the user

1. The stores to connect, as `*.myshopify.com` domains (for example `my-brand-dev.myshopify.com`).
2. Which of them may be written to. Default to read-only: only stores the user names as targets get write access.

Do not ask for tokens or passwords. The recommended sign-in goes through the user's browser.

## Requirements

- Node.js 22 or newer: `node --version`
- Shopify CLI 4.9 or newer, for the sign-in: `shopify version`. If it's missing or older, install it with `npm install -g @shopify/cli`.

## Step 1: sign in to each store

Run this once per store, in a terminal the user can see. It opens Shopify in the user's browser, and the user must click **Install** to approve. Wait for `Connected to ...` before moving on.

```bash
npx -y shopify-store-sync-mcp connect my-brand-dev.myshopify.com              # read-only
npx -y shopify-store-sync-mcp connect my-brand-staging.myshopify.com --writes # only for stores that may be written to
```

Each run prints the line to add to `stores.json`.

## Step 2: create stores.json

Create a `stores.json` file in a folder the user chooses (for example `~/shopify-store-sync/stores.json`) with the lines printed in step 1:

```json
{
  "stores": {
    "dev":     { "domain": "my-brand-dev.myshopify.com", "auth": "shopify-cli" },
    "staging": { "domain": "my-brand-staging.myshopify.com", "auth": "shopify-cli", "allowWrites": true }
  }
}
```

The keys (`dev`, `staging`) are the names the user will use in requests. Only add `"allowWrites": true` to stores the user agreed may be written to. Add `"protected": true` to a production store, so that every apply asks the user to confirm with its domain first.

Check the file loads:

```bash
SHOPIFY_STORES_FILE=/absolute/path/to/stores.json npx -y shopify-store-sync-mcp stores
```

## Step 3: add the server to the MCP settings

For Cline, add this to `cline_mcp_settings.json`, using the absolute path of the file from step 2:

```json
{
  "mcpServers": {
    "shopify-store-sync": {
      "command": "npx",
      "args": ["-y", "shopify-store-sync-mcp"],
      "env": { "SHOPIFY_STORES_FILE": "/absolute/path/to/stores.json" },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

On Windows, if `npx` isn't found, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "shopify-store-sync-mcp"]`.

## Step 4: verify

Call the `list_stores` tool. It should return the stores from `stores.json` and the server's version. Then try a read-only comparison, for example `diff_stores` with `source: "dev"`, `target: "staging"` and `resources: ["menus"]`.

## Good to know

- Every tool is read-only toward Shopify except `apply_plan` and `cancel_apply`. The read-only ones can be added to `autoApprove`; leave `apply_plan` and `cancel_apply` out.
- Writes only happen through a plan: `plan_sync` makes a dry-run plan, the user reviews it, then `apply_plan` applies it. Nothing is ever deleted.
- The Shopify CLI sign-in expires after a while. When a tool says so, run `connect` for that store again.
- For unattended runs, or stores where the user has no staff account, see "Connect your stores" in the README for the Dev Dashboard app option.
