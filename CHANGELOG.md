# Changelog

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
