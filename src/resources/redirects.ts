import { assertNoUserErrors, maxItems, paginate } from "../shopify/client.js";
import type { ResourceAdapter } from "./types.js";
import { PAGE_INFO } from "./util.js";

const QUERY = /* GraphQL */ `
  query Redirects($after: String) {
    urlRedirects(first: 250, after: $after) {
      nodes { id path target }
      ${PAGE_INFO}
    }
  }
`;

export const redirects: ResourceAdapter = {
  kind: "redirects",
  description: "URL redirects, keyed by path.",
  parallel: true,

  async fetch(client) {
    const nodes = await paginate<{ id: string; path: string; target: string }>(client, QUERY, {}, (d) => d.urlRedirects, Math.max(maxItems(), 250_000));
    return { items: nodes.map((n) => ({ key: n.path, id: n.id, data: { path: n.path, target: n.target } })), skipped: [] };
  },

  async create({ client }, _key, d) {
    const res = await client.request(
      `mutation($r: UrlRedirectInput!) { urlRedirectCreate(urlRedirect: $r) { urlRedirect { id } userErrors { field message code } } }`,
      { r: { path: d.path, target: d.target } },
    );
    assertNoUserErrors(res.urlRedirectCreate, `urlRedirectCreate ${String(d.path)}`);
    return res.urlRedirectCreate.urlRedirect.id;
  },

  async update({ client }, target, d) {
    const res = await client.request(
      `mutation($id: ID!, $r: UrlRedirectInput!) { urlRedirectUpdate(id: $id, urlRedirect: $r) { urlRedirect { id } userErrors { field message code } } }`,
      { id: target.id, r: { target: d.target } },
    );
    assertNoUserErrors(res.urlRedirectUpdate, `urlRedirectUpdate ${target.key}`);
  },
};
