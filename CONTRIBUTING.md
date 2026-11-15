# Contributing

Thanks for helping. This project is small on purpose: one engine (snapshot, diff, plan, apply) and one adapter per Shopify resource.

## Setup

```bash
git clone https://github.com/ussefidder/shopify-store-sync-mcp.git
cd shopify-store-sync-mcp
npm install
npm test
```

Node 22 or newer.

## Before opening a PR

```bash
npm run check    # typecheck, lint, tests, and GraphQL validation against Shopify's schema
```

The last step checks every query and mutation in `src/` against Shopify's published Admin schema, so a typo in a field name fails locally instead of on someone's store. There is no hosted CI on this repository: `npm run check` is the gate, and `npm publish` runs it again.

## Adding a resource type

1. Create `src/resources/<name>.ts` exporting a `ResourceAdapter`:
   - `fetch(client, opts)`: read every item and return `{ key, id, data }`. `key` must be identical across stores (a handle, a path, a type). `data` is what gets compared and copied: leave out IDs, timestamps and anything store-specific. GIDs inside `data` are rewritten to portable refs for you.
   - `create(ctx, key, data)` and `update(ctx, target, data)`: write it. Refs in `data` are already resolved to target GIDs. Use `assertNoUserErrors` on every mutation payload.
   - Optional: `conflict()` for changes Shopify can't make in place, and `refFor()` if other resources can reference this one.
   - If the mutation **replaces a list** (menu items, product tags, files...), an update must read the target first and send back what only the target has. Add `alignTarget()` so those kept items don't show up as differences, and a test that proves nothing is removed.
   - Set `parallel: true` only when items of the kind don't depend on each other.
2. Register it in `src/resources/index.ts` and add the kind to `RESOURCE_KINDS` in `types.ts`. **Order matters**: things that are referenced go before the things that reference them.
3. Teach `test/fakeShop.ts` the new queries and mutations, and add a test in `test/sync.test.ts`.
4. Document it in the README table.

## Principles

- **Never delete.** If a feature needs deletes, it goes behind an explicit opt-in flag and gets its own review. This includes deleting by omission: a mutation that replaces a list deletes whatever isn't sent.
- **A person confirms writes to protected stores.** Nothing the assistant can read or pass counts as confirmation.
- **Input is input.** Snapshot folders, plan files and store content are validated or treated as data, never trusted.
- **Fail loudly.** A read that can't be completed is an error, never a shorter list.
- **Never copy a raw GID across stores.** Map it, or leave it out with a warning.
- **Read-only tools stay read-only.** Only `apply_plan` writes.
- **Errors should say what to do next**: which store, which key, which setting.

## Releasing

1. `npm run check`, then `npm audit` (it should report 0).
2. Bump `version` in `package.json` (the server reads it from there) and in `server.json` (both places; a test checks they match), and add the changelog entry.
3. Update the numbers in the README and in `scripts/render-docs-images.mjs` (tests, operations), then `npm run docs:images`.
4. Commit, `git tag vX.Y.Z`, push with tags, and create the GitHub release from the changelog entry.
5. `npm publish --access public` (runs typecheck, lint, tests and the build first).
6. Update the [MCP Registry](https://registry.modelcontextprotocol.io) listing: `mcp-publisher login github`, then `mcp-publisher publish` from the repo root. The registry checks that the npm package of that version exists and carries the same `mcpName`.

### Each quarter (Shopify ships a new Admin API version in January, April, July and October)

1. `npm run validate:graphql -- <new version>`, and again for the oldest version still supported. Fix what fails.
2. Set `DEFAULT_API_VERSION` in `src/config.ts` to the newest stable version, and update the README badge and option tables.
3. Check [Shopify's developer changelog](https://shopify.dev/changelog) for deprecations that touch `src/resources/`. Known one: `src/resources/collections.ts` uses `Collection.ruleSet` and the `input` argument of `collectionCreate` / `collectionUpdate`. Their replacement (collection sources) exists from 2026-07. Move over once 2026-04 is no longer supported, and before `ruleSet` is removed (it is valid through 2027-01).
4. Check that the Node version in `engines` is still a supported one.

## Reporting a bug

Include the tool call, the resource types involved and the error text. **Remove access tokens and store domains you don't want public.** For a security problem, see [SECURITY.md](SECURITY.md).
