# Security

## Supported versions

Fixes go into the latest release on npm. Please upgrade before reporting.

## Reporting a vulnerability

Please don't open a public issue for a security problem. Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/ussefidder/shopify-store-sync-mcp/security/advisories/new).

Include what you did, what happened and what you expected. Remove access tokens, client secrets and
store domains you don't want shared. You should get an answer within a week.

## What this tool does with your data

- It runs on your machine and talks only to Shopify (the Admin API, or Shopify CLI on your behalf).
- Credentials are read from `stores.json` or environment variables and are never returned by a tool,
  written to a plan or logged.
- Plans and the audit log are kept in `~/.shopify-store-sync` (files readable by you only). Plans hold
  the store content they would write; they are removed a week after they were made.

## What it defends against

An AI assistant using this server reads store content: page bodies, product descriptions, metaobject
values. That content can carry instructions written by someone else (prompt injection). The design
assumes it might:

- Writes are off per store until you set `allowWrites`.
- A store marked `protected` can only be written to after a person confirms, in the client or on the
  command line. The assistant can't supply that confirmation.
- Every write goes through a plan you can read first, and nothing is ever deleted.
- Over MCP, snapshot folders are confined to one base folder, snapshot files are validated, and files
  are only uploaded from Shopify's own file hosts.

Mark production stores as `protected`. That is the setting that keeps a person in the loop.

## Out of scope

- What someone with access to your machine, your `stores.json` or your Shopify sign-in can do.
- Changes you reviewed in a plan and applied yourself.
