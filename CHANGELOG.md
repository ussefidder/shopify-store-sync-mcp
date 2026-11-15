# Changelog

## 0.5.0

A hardening release: every finding of an audit of 0.4.0 (code, package, docs, and Shopify's current API) is fixed or, for one, documented with the reason.

**Keeps its promises**

- Menus: updating a menu no longer removes the links only the target has. They are kept in place, and the plan names them
- Products: updating a product keeps the target's own tags, videos and 3D models (images and variants were already kept). All variants and media are read, however many pages they take
- Protected stores are confirmed by a person. Over MCP the client asks you to type the store's domain (elicitation); a client that can't ask is pointed to the command line. The `confirm` argument of `apply_plan` is ignored unless the server runs with `SYNC_ALLOW_AGENT_CONFIRM=true`
- Snapshot folders are validated: known resource types only (a manifest can't point outside the folder), item files checked, file URLs only on Shopify's hosts. Uploads refuse any other host
- Over MCP, `export_snapshot` and `dir:` sources stay inside one base folder (`SYNC_SNAPSHOT_DIR`, or the folder the server runs in)

**Behaviour**

- A metaobject field or translated field that only the target has no longer shows up as a difference forever
- A list longer than the read limit is an error, not a shorter list (`SYNC_MAX_ITEMS`, default 50,000). Menu and customer account page lookups read every page
- A mistyped command prints an error instead of starting the MCP server
- Time limits: 60 seconds per request, 120 per Shopify CLI call (`SYNC_REQUEST_TIMEOUT_MS`, `SYNC_CLI_TIMEOUT_MS`). A read is asked again; a write is never repeated blindly
- New `as_drafts` option (`--as-drafts`): new pages are created hidden and new metaobject entries as drafts, existing ones keep their state. Without it, the plan warns when new pages or entries would be visible right away, and says that new collections aren't on any sales channel
- Applying is faster: independent items are written 4 at a time (`SYNC_WRITE_CONCURRENCY`), never two values of the same product at once, and a file several items need is uploaded once
- MCP progress notifications while reading and applying, for clients that ask for them
- Metafield values: products and collections are read in parallel, and only the named ones when the include patterns name their owner (`PRODUCT/linen-shirt/*`)
- Windows: Shopify CLI gets plain file names and runs inside its temp folder, so no path is passed through `cmd.exe`; values `cmd.exe` would expand are refused
- Plan files are removed a week after they were made; a damaged plan file is ignored instead of breaking `plans`

**Shopify**

- Products also copy the category, the taxable flag and the inventory policy of variants; translations now cover products
- README no longer tells store owners to create a custom app in the store admin (not possible for new apps since January 1, 2026); it explains what to do for a store in another organization
- Collections still use the deprecated `ruleSet` and `input` argument on purpose: their replacement only exists from Admin API 2026-07 and stores pinned to 2026-04 are still supported. The reason and the deadline are written down in the code and in CONTRIBUTING

**Package and repo**

- Node 22 or newer (Node 20 is past its end of life)
- The npm package no longer ships source maps (32 files instead of 60)
- The version is read from `package.json` in one place
- ESLint with typescript-eslint; `npm run check` runs typecheck, lint, tests and schema validation
- vitest 5 (the 3.x line had known vulnerabilities, development only); `npm audit` reports 0 for all dependencies
- SECURITY.md, a release checklist in CONTRIBUTING, git tags and GitHub releases
- 103 tests (was 68), 56 GraphQL operations validated on 2026-04, 2026-10 and 2027-01

**Changes you may notice when upgrading**

- `apply_plan` on a protected store now asks you instead of accepting `confirm` from the assistant
- Over MCP, snapshot folders outside the base folder are refused: set `SYNC_SNAPSHOT_DIR`
- Product diffs can show `category`, `taxable` and `inventoryPolicy` the first time
- A store with more than 50,000 items of one type needs `SYNC_MAX_ITEMS` raised, or a narrower read

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
