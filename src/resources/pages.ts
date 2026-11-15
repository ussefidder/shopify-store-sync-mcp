import { assertNoUserErrors, paginate } from "../shopify/client.js";
import { REF_PREFIX } from "../refs.js";
import type { Item, ResourceAdapter } from "./types.js";
import { compact, PAGE_INFO } from "./util.js";

const QUERY = /* GraphQL */ `
  query Pages($after: String) {
    pages(first: 100, after: $after) {
      nodes { id handle title body isPublished templateSuffix }
      ${PAGE_INFO}
    }
  }
`;

interface Node {
  id: string;
  handle: string;
  title: string;
  body: string;
  isPublished: boolean;
  templateSuffix: string | null;
}

export function normalizePage(n: Node): Item {
  return {
    key: n.handle,
    id: n.id,
    data: compact({
      handle: n.handle,
      title: n.title,
      body: n.body,
      isPublished: n.isPublished,
      templateSuffix: n.templateSuffix || undefined,
    }),
  };
}

export const pages: ResourceAdapter = {
  kind: "pages",
  description: "Online store pages, keyed by handle (title, body HTML, template, published state). With as_drafts, new pages are created hidden and the published state is left alone.",
  parallel: true,

  async fetch(client) {
    const nodes = await paginate<Node>(client, QUERY, {}, (d) => d.pages);
    return { items: nodes.map(normalizePage), skipped: [] };
  },

  refFor(key) {
    return `${REF_PREFIX}Page/${key}`;
  },

  async create({ client }, _key, d) {
    const res = await client.request(
      `mutation($page: PageCreateInput!) { pageCreate(page: $page) { page { id } userErrors { field message code } } }`,
      // No published state in the data means the plan was made with as_drafts: the new page starts hidden.
      { page: compact({ handle: d.handle, title: d.title, body: d.body, isPublished: d.isPublished ?? false, templateSuffix: d.templateSuffix }) },
    );
    assertNoUserErrors(res.pageCreate, `pageCreate ${String(d.handle)}`);
    return res.pageCreate.page.id;
  },

  async update({ client }, target, d) {
    const res = await client.request(
      `mutation($id: ID!, $page: PageUpdateInput!) { pageUpdate(id: $id, page: $page) { page { id } userErrors { field message code } } }`,
      {
        id: target.id,
        page: compact({ title: d.title, body: d.body ?? "", isPublished: d.isPublished, templateSuffix: d.templateSuffix ?? "" }),
      },
    );
    assertNoUserErrors(res.pageUpdate, `pageUpdate ${target.key}`);
  },
};
