# Changelog

## 0.3.0

- Connect a store without creating an app: `connect <store>` signs in through Shopify CLI (`shopify store auth`) in the browser, and `"auth": "shopify-cli"` in `stores.json` sends requests through `shopify store execute`
- Read-only scopes are requested unless the store allows writes (or `--writes` is passed)
- Clear messages when Shopify CLI is missing or the sign-in has expired

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
