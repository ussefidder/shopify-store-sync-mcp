# Contributing

Thanks for helping. This project is small on purpose: one engine (snapshot, diff, plan, apply) and one adapter per Shopify resource.

## Setup

```bash
git clone https://github.com/ussefidder/shopify-store-sync-mcp.git
cd shopify-store-sync-mcp
npm install
npm test
```

Node 20+.

## Before opening a PR

```bash
npm run typecheck
npm test
npm run validate:graphql
```

`validate:graphql` checks every query and mutation in `src/` against Shopify's published Admin schema, so a typo in a field name fails locally instead of on someone's store. Please run all three before opening a PR.

## Adding a resource type

1. Create `src/resources/<name>.ts` exporting a `ResourceAdapter`:
   - `fetch(client, opts)`: read every item and return `{ key, id, data }`. `key` must be identical across stores (a handle, a path, a type). `data` is what gets compared and copied: leave out IDs, timestamps and anything store-specific. GIDs inside `data` are rewritten to portable refs for you.
   - `create(ctx, key, data)` and `update(ctx, target, data)`: write it. Refs in `data` are already resolved to target GIDs. Use `assertNoUserErrors` on every mutation payload.
   - Optional: `conflict()` for changes Shopify can't make in place, and `refFor()` if other resources can reference this one.
2. Register it in `src/resources/index.ts` and add the kind to `RESOURCE_KINDS` in `types.ts`. **Order matters**: things that are referenced go before the things that reference them.
3. Teach `test/fakeShop.ts` the new queries and mutations, and add a test in `test/sync.test.ts`.
4. Document it in the README table.

## Principles

- **Never delete.** If a feature needs deletes, it goes behind an explicit opt-in flag and gets its own review.
- **Never copy a raw GID across stores.** Map it, or leave it out with a warning.
- **Read-only tools stay read-only.** Only `apply_plan` writes.
- **Errors should say what to do next**: which store, which key, which setting.

## Reporting a bug

Include the tool call, the resource types involved and the error text. **Remove access tokens and store domains you don't want public.**
