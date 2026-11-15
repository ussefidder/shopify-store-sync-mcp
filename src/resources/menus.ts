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

/*
 * menuUpdate replaces a menu's whole item tree. To keep the "never deletes" promise, links that
 * only the target has are sent back along with the source's. Two links are the same link when
 * they have the same type and point at the same thing (a resource, else a URL, else a title).
 */

type Linkish = { title: string; type: string; url?: string | null; resourceId?: string | null };

export function menuItemIdentity(i: Linkish): string {
  return `${i.type}|${i.resourceId || i.url || i.title}`;
}

/** Pair each source item with a target item of the same identity (first come, first served). */
function pairItems<S extends Linkish, T extends Linkish>(source: S[], target: T[]): { pairs: Map<S, T>; matched: Set<T> } {
  const pool = new Map<string, T[]>();
  for (const t of target) {
    const id = menuItemIdentity(t);
    pool.set(id, [...(pool.get(id) ?? []), t]);
  }
  const pairs = new Map<S, T>();
  const matched = new Set<T>();
  for (const s of source) {
    const t = pool.get(menuItemIdentity(s))?.shift();
    if (t) {
      pairs.set(s, t);
      matched.add(t);
    }
  }
  return { pairs, matched };
}

/** The target's items with the links only it has set aside, so a menu already in line compares as identical. */
export function alignMenuItems(source: MenuItemData[], target: MenuItemData[]): MenuItemData[] {
  const { pairs, matched } = pairItems(source, target);
  const sourceOf = new Map([...pairs].map(([s, t]) => [t, s]));
  return target
    .filter((t) => matched.has(t))
    .map((t) => {
      const children = alignMenuItems(sourceOf.get(t)!.items ?? [], t.items ?? []);
      return compact({ ...t, items: children.length ? children : undefined }) as MenuItemData;
    });
}

/** Titles of the links only the target has, at any depth. */
export function targetOnlyMenuItems(source: MenuItemData[], target: MenuItemData[], path = ""): string[] {
  const { pairs, matched } = pairItems(source, target);
  const sourceOf = new Map([...pairs].map(([s, t]) => [t, s]));
  return target.flatMap((t) =>
    matched.has(t) ? targetOnlyMenuItems(sourceOf.get(t)!.items ?? [], t.items ?? [], `${path}${t.title} > `) : [`${path}${t.title}`],
  );
}

/** A menu item as the store returns it, with its own id. */
export interface LiveMenuItem extends Linkish {
  id?: string;
  tags?: string[] | null;
  items?: LiveMenuItem[];
}

function liveInput(i: LiveMenuItem): Record<string, unknown> {
  return compact({
    id: i.id,
    title: i.title,
    type: i.type,
    // A link to a resource is identified by resourceId; its URL is derived by Shopify.
    url: i.resourceId ? undefined : i.url || undefined,
    resourceId: i.resourceId || undefined,
    tags: i.tags?.length ? i.tags : undefined,
    items: i.items?.length ? i.items.map(liveInput) : undefined,
  });
}

/**
 * Items to send to menuUpdate: the source's (updating the matching target item in place), with
 * every link only the target has kept right after the item it followed.
 */
export function mergeMenuItems(source: MenuItemData[], target: LiveMenuItem[]): Record<string, unknown>[] {
  const { pairs, matched } = pairItems(source, target);
  const out: Record<string, unknown>[] = [];
  const placed = new Map<LiveMenuItem, Record<string, unknown>>();
  for (const s of source) {
    const t = pairs.get(s);
    const children = mergeMenuItems(s.items ?? [], t?.items ?? []);
    const input = compact({ ...itemInput({ ...s, items: undefined }), id: t?.id, items: children.length ? children : undefined });
    out.push(input);
    if (t) placed.set(t, input);
  }
  let anchor = -1;
  for (const t of target) {
    if (matched.has(t)) {
      anchor = out.indexOf(placed.get(t)!);
    } else {
      out.splice(++anchor, 0, liveInput(t));
    }
  }
  return out;
}

const LIVE_ITEM = "id title type url resourceId tags";
const LIVE_QUERY = /* GraphQL */ `
  query MenuItems($id: ID!) {
    menu(id: $id) {
      id
      items {
        ${LIVE_ITEM}
        items {
          ${LIVE_ITEM}
          items { ${LIVE_ITEM} }
        }
      }
    }
  }
`;

export const menus: ResourceAdapter = {
  kind: "menus",
  description:
    "Navigation menus, keyed by handle. Links to products, collections, pages, blogs and metaobjects are remapped by handle. Links that only the target menu has are kept.",

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

  alignTarget(source, target) {
    return { ...target, items: alignMenuItems((source.items as MenuItemData[]) ?? [], (target.items as MenuItemData[]) ?? []) };
  },

  targetOnly(source, target) {
    return targetOnlyMenuItems((source.items as MenuItemData[]) ?? [], (target.items as MenuItemData[]) ?? []);
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
    // menuUpdate replaces the item tree, so the menu is read again and its own links are sent back with the source's.
    const live = await client.request<{ menu: { items: LiveMenuItem[] } | null }>(LIVE_QUERY, { id: target.id });
    if (!live.menu) throw new Error(`menu ${target.key} no longer exists in the target`);
    const res = await client.request(
      `mutation($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
        menuUpdate(id: $id, title: $title, items: $items) { menu { id } userErrors { field message code } }
      }`,
      { id: target.id, title: d.title, items: mergeMenuItems((d.items as MenuItemData[]) ?? [], live.menu.items) },
    );
    assertNoUserErrors(res.menuUpdate, `menuUpdate ${target.key}`);
  },
};
