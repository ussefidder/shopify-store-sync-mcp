import { assertNoUserErrors } from "../shopify/client.js";
import { REF_PREFIX } from "../refs.js";
import type { ResourceAdapter } from "./types.js";

/** Store policies (refund, privacy, shipping...), keyed by type. Every store has the same set of types. */
export const shopPolicies: ResourceAdapter = {
  kind: "shop_policies",
  description: "Store policies (refund, privacy, terms, shipping, contact...), keyed by type. Copies the policy text.",

  async fetch(client) {
    const d = await client.request<{ shop: { shopPolicies: { id: string; type: string; body: string }[] } }>(
      `query ShopPolicies { shop { shopPolicies { id type body } } }`,
    );
    return {
      items: d.shop.shopPolicies.filter((p) => p.body?.trim()).map((p) => ({ key: p.type, id: p.id, data: { type: p.type, body: p.body } })),
      skipped: [],
    };
  },

  refFor(key) {
    return `${REF_PREFIX}ShopPolicy/${key}`;
  },

  async create({ client }, _key, d) {
    const res = await client.request(
      `mutation($p: ShopPolicyInput!) { shopPolicyUpdate(shopPolicy: $p) { shopPolicy { id } userErrors { field message } } }`,
      { p: { type: d.type, body: d.body } },
    );
    const errors: { message: string }[] = res.shopPolicyUpdate?.userErrors ?? [];
    if (errors.some((e) => /automatic management/i.test(e.message))) {
      throw new Error(
        `${String(d.type)} is managed automatically by Shopify in the target. Turn that off under Settings > Policies to sync it, or leave it out with --exclude ${String(d.type)}.`,
      );
    }
    assertNoUserErrors(res.shopPolicyUpdate, `shopPolicyUpdate ${String(d.type)}`);
    return res.shopPolicyUpdate.shopPolicy.id;
  },

  async update(ctx, target, d) {
    await shopPolicies.create(ctx, target.key, d);
  },
};
