import { accessDenied, paginate, ShopifyError } from "../shopify/client.js";
import type { Item, ResourceAdapter } from "./types.js";
import { compact, PAGE_INFO } from "./util.js";

/*
 * Discounts, compared only. Automatic discounts are keyed by "automatic/<title>", code discounts by
 * "code/<title>". What is compared: the kind of discount, Shopify's own summary of what it gives
 * (value, items, minimum), status, dates, what it combines with, the codes, usage limits, and for
 * app discounts the function behind them. Plans report differences as conflicts and never write:
 * a discount changes what customers pay, so it is left to a person in the admin.
 * Needs read_discounts.
 */

const COMMON = "title status startsAt endsAt discountClasses combinesWith { orderDiscounts productDiscounts shippingDiscounts }";
const CODE = "codes(first: 50) { nodes { code } } codesCount { count } usageLimit appliesOncePerCustomer";

// 10 discounts with up to 50 codes each stays well under the cost limit of one request.
const QUERY = /* GraphQL */ `
  query Discounts($after: String) {
    discountNodes(first: 10, after: $after) {
      nodes {
        id
        discount {
          __typename
          ... on DiscountAutomaticBasic { ${COMMON} summary }
          ... on DiscountAutomaticBxgy { ${COMMON} summary }
          ... on DiscountAutomaticFreeShipping { ${COMMON} summary }
          ... on DiscountAutomaticApp { ${COMMON} appDiscountType { functionId title } }
          ... on DiscountCodeBasic { ${COMMON} summary ${CODE} }
          ... on DiscountCodeBxgy { ${COMMON} summary ${CODE} }
          ... on DiscountCodeFreeShipping { ${COMMON} summary ${CODE} }
          ... on DiscountCodeApp { ${COMMON} ${CODE} appDiscountType { functionId title } }
        }
      }
      ${PAGE_INFO}
    }
  }
`;

interface Node {
  id: string;
  discount: {
    __typename: string;
    title: string;
    status: string;
    startsAt: string;
    endsAt: string | null;
    discountClasses?: string[];
    combinesWith: Record<string, boolean>;
    summary?: string;
    codes?: { nodes: { code: string }[] };
    codesCount?: { count: number };
    usageLimit?: number | null;
    appliesOncePerCustomer?: boolean;
    appDiscountType?: { functionId: string; title: string };
  };
}

/** "DiscountCodeBxgy" -> "code", "bxgy". */
function kindOf(typename: string): { method: "automatic" | "code"; type: string } {
  const m = /^Discount(Automatic|Code)(\w+)$/.exec(typename);
  return { method: m?.[1] === "Code" ? "code" : "automatic", type: (m?.[2] ?? typename).replace(/^Basic$/, "amount_off").replace(/^FreeShipping$/, "free_shipping").toLowerCase() };
}

export function normalizeDiscount(n: Node): Item {
  const d = n.discount;
  const { method, type } = kindOf(d.__typename);
  const codes = d.codes?.nodes.map((c) => c.code).sort();
  const many = (d.codesCount?.count ?? 0) > (codes?.length ?? 0);
  return {
    key: `${method}/${d.title}`,
    id: n.id,
    data: compact({
      type,
      title: d.title,
      summary: d.summary,
      status: d.status,
      startsAt: d.startsAt,
      endsAt: d.endsAt,
      discountClasses: d.discountClasses ? [...d.discountClasses].sort() : undefined,
      combinesWith: d.combinesWith,
      // Bulk code sets are compared by size: listing thousands of codes says nothing useful.
      codes: many ? undefined : codes,
      codesCount: d.codesCount?.count,
      usageLimit: d.usageLimit,
      appliesOncePerCustomer: d.appliesOncePerCustomer,
      app: d.appDiscountType ? `${d.appDiscountType.title} (${d.appDiscountType.functionId})` : undefined,
    }),
  };
}

const READ_ONLY = "discounts are compared only, never written: a discount changes what customers pay, so set it up in the target's admin";

export const discounts: ResourceAdapter = {
  kind: "discounts",
  description:
    "Discounts, compared only (never written): automatic ones keyed by automatic/<title>, code ones by code/<title>. Compares the type, Shopify's summary of what the discount gives, status, dates, combinations, codes and usage limits. Opt-in; needs read_discounts.",

  async fetch(client) {
    const items: Item[] = [];
    const skipped: { key: string; reason: string }[] = [];
    let nodes: Node[];
    try {
      nodes = await paginate<Node>(client, QUERY, {}, (d) => d.discountNodes);
    } catch (e) {
      if (accessDenied(e) === undefined) throw e;
      skipped.push({ key: "*", reason: "not readable with this store's permissions (Shopify needs read_discounts); connect the store again to grant it" });
      return { items, skipped };
    }
    const seen = new Map<string, number>();
    for (const n of nodes) {
      if (!n.discount?.__typename) continue;
      const item = normalizeDiscount(n);
      seen.set(item.key, (seen.get(item.key) ?? 0) + 1);
      items.push(item);
    }
    // Two discounts with the same title can't be told apart across stores.
    const dupes = [...seen].filter(([, count]) => count > 1).map(([key]) => key);
    for (const key of dupes) skipped.push({ key, reason: "several discounts have this title, so they can't be matched across stores; give them distinct titles to compare them" });
    return { items: items.filter((i) => !dupes.includes(i.key)), skipped };
  },

  readOnly: () => READ_ONLY,

  async create() {
    throw new ShopifyError(READ_ONLY);
  },

  async update() {
    throw new ShopifyError(READ_ONLY);
  },
};
