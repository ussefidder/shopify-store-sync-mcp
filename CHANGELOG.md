# Changelog

## 0.10.4

Found in the 4,000-product live test:

- **`cancel_apply`**: stops a running apply and the Shopify bulk operations it started, and reports what was written before it stopped. It also stops bulk operations left running by an apply whose server was restarted. Nothing is rolled back or deleted
- **Products no longer reported as failed when they were written.** When a bulk operation ends without results (abandoned or cancelled), the store is asked which of its products exist now, and those count as created
- **What belongs to a product that could not be created fails at once**, with that as the reason, instead of each value being looked up in the target one request at a time
- **Many metafield values on existing products**: the products and variants they belong to are found with one bulk export instead of one request per product, when planning and when applying. On 4,000 products that was about 4,000 requests each time
- `apply_status` counts failures per resource type and reason, so the first cause is not buried under what failed because of it; `resource` lists one type's failures. It still answers after a server restart, marking the apply as interrupted, and `get_plan` shows how the plan's apply went

## 0.10.3

- **Big bulk writes are no longer cut off after 30 minutes.** A bulk operation is now given up on only when it has written nothing more for 30 minutes (`SYNC_BULK_TIMEOUT_MS`), however long it runs. Shopify writes about 12 new products a minute per operation (5 at once) when each has around a dozen variants with stock and images, so 800 products take over an hour. Before, every product of an operation still running at 30 minutes was reported as failed while Shopify went on creating them, and the metafield values that followed failed for lack of their product
- Live progress in a terminal: `shopify-store-sync-mcp status --watch` shows a running apply's written, failed and left counts, bulk progress and time left, from a status file the MCP server keeps
- The apply's phase names the bulk write that is running

## 0.10.2

- A bulk write no longer stops the whole apply when one status check or result download fails: it tries again a few times, since the operation keeps running on Shopify's side. In the 4,000-product live test on 0.9.2, all products arrived but the apply stopped silently before the metafield values
- Bulk file uploads and downloads give up after 5 minutes instead of waiting forever

## 0.10.1

- "Not signed in" errors now include what Shopify CLI said, and a read that hits an expired-looking sign-in is asked once more, in case another process was renewing it at that moment
- A snapshot folder holding prices or stock no longer shows them as differences unless `prices` or `inventory` is asked for, the same as when reading a store

## 0.10.0

- **A big apply no longer blocks.** A plan of more than 50 steps (`SYNC_BACKGROUND_STEPS`) is applied in the background and `apply_plan` returns at once, so a client's time limit on one call no longer cuts it off. Pass `wait: true` to wait as before
- **`apply_status`**: created, updated, skipped, failed and left per resource type, the current phase, how far Shopify has got inside a bulk operation, time so far and time remaining, and the latest failures
- **Product updates in bulk** above 250 products, still keeping the variants, tags and media only the target has
- **Images created once**: before a bulk product write, missing images are created all at the same time, once each. An image several products share is no longer copied per product, and no product write waits on a download
- Bulk writes start the next part as soon as one finishes when the store runs fewer at once, a failed part no longer loses the others, and results reach the audit log part by part
- Short reports: Markdown diffs and plans list 50 items per section over MCP, with counts of the rest, and plans count creates, updates and conflicts per resource type
- Decimal values written two ways (`0.40` and `0.4`) in decimal metafields and prices are no longer differences
- `list_stores` gives the server's version; `compare_item` reports use a section heading

## 0.9.2

- Metafield values leave out Shopify's own copies of built-in fields: the SEO title and description (`global.title_tag`, `global.description_tag`) and a variant's HS code (`global.harmonized_system_code`). They travel with the product or collection itself; on a 4,000-product catalog they were 54,000 of 144,000 planned writes

## 0.9.1

- Tested live with 4,000 products and 46,000 variants: written with images, stock and 86,000 metafield values in about 10 minutes
- Metafield values pointing at an image that the bulk product write had just brought over are written too (they failed as "not found" before)
- Metafield values of big catalogs: the products and variants they belong to are no longer looked up again one batch at a time
- A handle prefix (`--include "summer-*"`) on a big catalog is read with one bulk export instead of 4 products per request
- Variant metafields use a bulk read when the store has many variants, even with few products

## 0.9.0

- **Everything on the product page.** Products now also carry each variant's barcode, weight, inventory tracking, shipping setting, customs details (HS code, country of origin) and its image. These are compared and copied like the other fields, so a diff may show them as new differences the first time
- **Stock, opt-in**: `inventory: true` (`--with-inventory`) copies the available quantity per location into the target's location with the same name. New variants get it on creation; existing ones are set against the target's current quantity, so a sale in between isn't overwritten. Needs `read_inventory`, `read_locations` and `write_inventory`, now part of the scopes `connect` asks for: run `connect` again to use it
- **Bulk writes for big syncs**: above 250 items (`SYNC_BULK_THRESHOLD`), new products are written by Shopify bulk operations, split into up to 5 running at once (`SYNC_BULK_PARALLEL`), with their images taken straight from the source's URLs; metafield values go 25 per call the same way. If a store won't run bulk writes, the tool falls back to one by one
- **Faster planning**: files are looked up 25 at a time and products 10 at a time, and metafield values of big catalogs are read in bulk
- Variant metafields on products the plan creates are no longer reported as conflicts

## 0.8.1

- **Products on big catalogs, hours down to minutes.** Comparing a small store with a big one (72 products against 4,530) no longer reads the big one in full: both stores are first listed by handle (250 per request), and only the products both have are read in full. The others still show as "only in target"
- **Bulk reads** for a full product read above 250 products (`SYNC_BULK_THRESHOLD`): Shopify exports the catalog on its side and the tool downloads one file, instead of paging through it under the rate limit. Bulk reads only read; `bulkOperationRunQuery` is a mutation by name, so the Shopify CLI sign-in runs it with `--allow-mutations`
- Product images carry their URL in the product read, so they are no longer looked up again one batch at a time; the lookups that remain run 4 at a time. Products by handle are looked up 5 per request

## 0.8.0

- **Targeted checks.** `check <source> <target> <resource> <key>` (tool: `compare_item`) compares one item side by side: each field that differs, and whether what it points at exists in the target. It reads only that item where Shopify allows it
- **Include patterns limit what is read**, not only what is shown: metaobject entries by handle (`size_guide/shirts`), metaobject types (`size_guide/*`, `size*`) and collections by handle, on top of products and metafield values. Every report now starts with what was compared
- **Faster**: metaobject types are read in parallel, metaobject entries are written 4 at a time, and the check before writing re-reads only the items the plan touches instead of whole resource types (the refresh before the second pass too). `SYNC_CLI_CONCURRENCY` sets how many Shopify CLI processes run at once
- **Progress on the command line**, on stderr: what was read, which step is being written and about how long is left, and a "still working" line every 10 seconds otherwise. `--quiet` turns it off

## 0.7.0

- **Full values in `--json`**: nothing is shortened any more, on `diff`, `plan` and `themes`
- **JSON values compared entry by entry**: a json metafield or a JSON setting that differs now says which entries differ (`fields.settings → markets[eu].currency`, `countries[+]`) instead of showing two long texts. Lists of objects are matched by key, handle, code, id or name rather than position
- **Markdown reports**: `--format md` on `diff`, `plan` and `themes`, and `format: "markdown"` on the `diff_stores`, `get_plan` and `diff_themes` tools, to paste into a ticket, a pull request or an email
- **Shopify CLI version check**: `connect` checks for Shopify CLI 4.9 or newer first, and an older CLI's "Nonexistent flag" error now says which version is needed
- **`connect --scopes read_customers,read_orders`**: extra read scopes, off by default because they expose customer data, to compare those owner types' metafield definitions. Only read scopes can be added
- **Shopify-reserved metafield definitions**: `include_reserved` (`--include-reserved`) compares the `shopify` namespace ones (category metafields behind storefront filters). Compared only: plans report them as conflicts and never write them
- **Theme diff, settings left out on purpose**: `ignore_settings` (`--ignore-settings`) takes globs on setting paths, optionally per file (`config/settings_data.json:current.color_*`); the report counts what was left out
- **Discounts, compared only** (opt-in `discounts`): automatic and code discounts by title, with Shopify's summary of what they give, status, dates, combinations, codes and usage limits. Never written. Needs `read_discounts`, now part of the read scopes `connect` asks for

## 0.6.0

- Metafield values on **product variants** (`PRODUCTVARIANT/<product handle>/<option values>/<namespace.key>`), matched to the target variant with the same option values; a variant the target doesn't have is skipped with a warning
- Metafield values on the **shop** (`SHOP/<namespace.key>`), written to the target's own shop
- References to variants are remapped (`shopify://ProductVariant/<handle>/<option values>`), in metafield values and metaobject fields alike; before, they were reported as unresolved
- `owner_types` (`--owner-types`) now also limits metafield values, and include patterns `PRODUCTVARIANT/<handle>/*` and `SHOP/*` read only those owners
- No new permissions: variants are covered by `read_products` / `write_products`

## 0.5.2

- Fixed: a store whose sign-in can't read some metafield owner types (customers, orders, locations, markets... need extra permissions) made the whole diff fail with "Access denied for pinnedPosition field". Those owner types are now reported as not compared, on both stores, and everything else is compared as usual
- `--include` patterns that start with owner types (`"PRODUCT.*,COLLECTION.*"`) now limit which metafield definitions are read, so other owner types aren't queried at all
- `diff` and `plan` list what could not be compared on stderr

## 0.5.1

- Listed in the official MCP Registry as `io.github.ussefidder/shopify-store-sync-mcp` (`mcpName` in `package.json`, `server.json` in the repo)
- No code changes
- README: a 74-second explainer video with voice-over (source and build scripts in `docs/video`), and an MCP Registry badge

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
