import { assertNoUserErrors, paginate } from "../shopify/client.js";
import { REF_PREFIX } from "../refs.js";
import type { Item, ResourceAdapter } from "./types.js";
import { compact, PAGE_INFO } from "./util.js";

const ITEM_FIELDS = "title type url resourceId tags";

const QUERY = /* GraphQL */ `
  query Menus($after: String) {
    menus(first: 50, after: $after) {
      nodes {
        id
        handle
        title
        items {
          ${ITEM_FIELDS}
          items {
            ${ITEM_FIELDS}
            items { ${ITEM_FIELDS} }
          }
        }
      }
      ${PAGE_INFO}
    }
  }
`;

interface MenuItemNode {
  title: string;
  type: string;
  url: string | null;
  resourceId: string | null;
  tags: string[];
  items?: MenuItemNode[];
}

export interface MenuItemData {
  title: string;
  type: string;
  url?: string;
  resourceId?: string;
  tags?: string[];
  items?: MenuItemData[];
}

/**
 * Items that point at a resource keep only resourceId (the URL is derived from it and
 * contains the store's own domain). Other items keep their URL.
 */
export function normalizeMenuItem(i: MenuItemNode): MenuItemData {
  const children = (i.items ?? []).map(normalizeMenuItem);
  return compact({
    title: i.title,
    type: i.type,
    resourceId: i.resourceId || undefined,
    url: i.resourceId ? undefined : i.url || undefined,
    tags: i.tags?.length ? [...i.tags].sort() : undefined,
    items: children.length ? children : undefined,
  }) as MenuItemData;
}

export function normalizeMenu(n: { id: string; handle: string; title: string; items: MenuItemNode[] }): Item {
  return {
    key: n.handle,
    id: n.id,
    data: { handle: n.handle, title: n.title, items: n.items.map(normalizeMenuItem) },
  };
}

function itemInput(i: MenuItemData): Record<string, unknown> {
  return compact({
    title: i.title,
    type: i.type,
    url: i.url,
    resourceId: i.resourceId,
    tags: i.tags,
    items: i.items?.map(itemInput),
  });
}

export const menus: ResourceAdapter = {
  kind: "menus",
  description: "Navigation menus, keyed by handle. Links to products, collections, pages, blogs and metaobjects are remapped by handle.",

  async fetch(client) {
    const nodes = await paginate<{ id: string; handle: string; title: string; items: MenuItemNode[] }>(
      client,
      QUERY,
      {},
      (d) => d.menus,
    );
    return { items: nodes.map(normalizeMenu), skipped: [] };
  },

  refFor(key) {
    return `${REF_PREFIX}Menu/${key}`;
  },

  async create({ client }, _key, d) {
    const res = await client.request(
      `mutation($handle: String!, $title: String!, $items: [MenuItemCreateInput!]!) {
        menuCreate(handle: $handle, title: $title, items: $items) { menu { id } userErrors { field message code } }
      }`,
      { handle: d.handle, title: d.title, items: (d.items as MenuItemData[]).map(itemInput) },
    );
    assertNoUserErrors(res.menuCreate, `menuCreate ${String(d.handle)}`);
    return res.menuCreate.menu.id;
  },

  async update({ client }, target, d) {
    // menuUpdate replaces the item tree; items without an id are created fresh.
    const res = await client.request(
      `mutation($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
        menuUpdate(id: $id, title: $title, items: $items) { menu { id } userErrors { field message code } }
      }`,
      { id: target.id, title: d.title, items: (d.items as MenuItemData[]).map(itemInput) },
    );
    assertNoUserErrors(res.menuUpdate, `menuUpdate ${target.key}`);
  },
};
