import { assertNoUserErrors, paginate } from "../shopify/client.js";
import type { ResourceAdapter } from "./types.js";
import { compact, PAGE_INFO } from "./util.js";

/*
 * Inventory locations, keyed by name: address and whether the location fulfills online orders.
 * Locations run by a fulfillment app are left out (the app owns them), and so are deactivated
 * ones. A location is never deactivated or deleted here; stock is copied by the products resource
 * (with inventory), into locations of the same name.
 */

const QUERY = /* GraphQL */ `
  query Locations($after: String) {
    locations(first: 100, after: $after, includeInactive: false) {
      nodes {
        id
        name
        isFulfillmentService
        fulfillsOnlineOrders
        address { address1 address2 city countryCode provinceCode zip phone }
      }
      ${PAGE_INFO}
    }
  }
`;

interface Node {
  id: string;
  name: string;
  isFulfillmentService: boolean;
  fulfillsOnlineOrders: boolean;
  address: Record<string, string | null>;
}

const ADDRESS_FIELDS = ["address1", "address2", "city", "countryCode", "provinceCode", "zip", "phone"] as const;

function address(a: Record<string, string | null> | undefined): Record<string, string> {
  return compact(Object.fromEntries(ADDRESS_FIELDS.map((f) => [f, a?.[f] || undefined]))) as Record<string, string>;
}

export const locations: ResourceAdapter = {
  kind: "locations",
  description:
    "Inventory locations, keyed by name: address and whether the location fulfills online orders. Locations run by fulfillment apps and deactivated ones are left out; nothing is ever deactivated or deleted. Opt-in.",

  async fetch(client) {
    const nodes = await paginate<Node>(client, QUERY, {}, (d) => d.locations);
    const skipped = nodes.filter((n) => n.isFulfillmentService).map((n) => ({ key: n.name, reason: "run by a fulfillment app" }));
    return {
      items: nodes
        .filter((n) => !n.isFulfillmentService)
        .map((n) => ({ key: n.name, id: n.id, data: { address: address(n.address), fulfillsOnlineOrders: n.fulfillsOnlineOrders } })),
      skipped,
    };
  },

  refFor: (key) => `shopify://Location/${key}`,

  /** Same name, different country: most likely two different places (a default "Shop location" in each store), not one to move. */
  conflict(source, target) {
    const a = (source.data.address as Record<string, string> | undefined)?.countryCode;
    const b = (target.data.address as Record<string, string> | undefined)?.countryCode;
    if (a && b && a !== b) {
      return `same name, but in ${a} in the source and ${b} in the target: probably two different places, so it isn't moved; rename one, or edit the address by hand`;
    }
    return undefined;
  },

  async create({ client }, key, d) {
    const a = address(d.address as Record<string, string>);
    if (!a.countryCode) throw new Error(`location ${key} has no country in the source; Shopify needs one to create it`);
    const res = await client.request(
      `mutation LocationAdd($input: LocationAddInput!) { locationAdd(input: $input) { location { id } userErrors { field message code } } }`,
      { input: { name: key, address: a, fulfillsOnlineOrders: d.fulfillsOnlineOrders } },
    );
    assertNoUserErrors(res.locationAdd, `locationAdd ${key}`);
    return res.locationAdd.location.id;
  },

  async update({ client }, target, d) {
    const res = await client.request(
      `mutation LocationEdit($id: ID!, $input: LocationEditInput!) { locationEdit(id: $id, input: $input) { location { id } userErrors { field message code } } }`,
      { id: target.id, input: { address: address(d.address as Record<string, string>), fulfillsOnlineOrders: d.fulfillsOnlineOrders } },
    );
    assertNoUserErrors(res.locationEdit, `locationEdit ${target.key}`);
  },
};
