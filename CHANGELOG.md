# Changelog

## 0.4.0

- New opt-in resource: `products`, keyed by handle. Copies title, description, vendor, type, tags, template, SEO, options, variants (matched by option values, with SKU) and images
- New products are created as drafts; prices are copied only with `prices: true` (`--with-prices`); inventory and sales channels are never copied
- Updates never delete: variants, images and option values that only the target has are kept, and the diff doesn't report them
- Products named by an include filter (exact handles or `prefix-*`) are read directly instead of scanning the catalog
- Plans remember their read options, so the drift check reads the target the same way
- `--values` prints lists and objects as JSON instead of `[object Object]`
- Tested live on Windows through the Shopify CLI sign-in

## 0.3.0

- Connect a store without creating an app: `connect <store>` signs in through Shopify CLI (`shopify store auth`) in the browser, and `"auth": "shopify-cli"` in `stores.json` sends requests through `shopify store execute`
- Read-only scopes are requested unless the store allows writes (or `--writes` is passed)
- Clear messages when Shopify CLI is missing or the sign-in has expired
- Works with Shopify CLI 4.9 and 5.x output, on Windows too; `stores.json` saved with a byte order mark is accepted
- Faster everywhere: resource types, both stores, metafield definition owner types, translations and reference lookups are read in parallel (a full diff with an app went from about 10 to 2 seconds)
- Tested end to end on Windows between two live stores, through the CLI and the MCP server

## 0.2.1

- Verified every feature end to end between two live development stores, through the CLI and the MCP server
- Metafield values whose product or collection doesn't exist in the target are now planned as skipped conflicts with the reason, instead of failing at apply
- A failed token request says why (for example, the app isn't installed on the store yet)
- A policy that Shopify manages automatically fails with how to unblock it
- `apply` on the command line says how many steps were written and skipped

## 0.2.0

- New resources: `collections` (with smart-collection rules), `shop_policies`, and opt-in `metafields` (values on products and collections) and `translations` (pages, collections, metaobjects, menus, policies)
- Files and images are matched by file name across stores and uploaded to the target when missing
- Config as code: `export_snapshot` writes a store's configuration to a folder for git; `dir:<path>` works as a source anywhere
- Read-only theme settings diff (`diff_themes`): JSON templates, section groups and settings_data.json
- Command line: `stores`, `diff`, `plan`, `apply`, `plans`, `export`, `themes`, with `--json` and `--exit-code`
- Collection rules on metafield definitions, menus and metafield definitions are now remapped too

## Unreleased

- Remap customer account pages and shop policies (menus such as `customer-account-main-menu` now sync)
- Menu links to resources that can't be matched are left out and reported, instead of being sent with an empty target
- Verified reads and writes against a live Shopify Plus development store

## 0.1.0

First release.

- Tools: `list_stores`, `list_resource_types`, `snapshot_store`, `diff_stores`, `plan_sync`, `get_plan`, `apply_plan`
- Resources: metafield definitions, metaobject definitions, metaobjects, pages, menus, redirects
- Cross-store ID remapping by handle for products, collections, pages, blogs, metaobjects and metaobject definitions
- Two-pass writes for references within the same plan, including self-referencing definitions
- Safety: writes off by default, protected stores, drift check before apply, no deletes, audit log
- Auth: static access tokens and Dev Dashboard client credentials
- Operations validated against Admin API 2026-04 to 2027-01
