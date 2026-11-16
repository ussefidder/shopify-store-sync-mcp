import { assertNoUserErrors, paginate } from "../shopify/client.js";
import { REF_PREFIX } from "../refs.js";
import type { Item, ResourceAdapter } from "./types.js";
import { compact, PAGE_INFO } from "./util.js";

/*
 * Collections: title, description, sort order, template, SEO and, for smart collections,
 * their rules. Manual collections keep their own product lists: membership is not copied.
 * A new collection is not published to any sales channel; publish it in the target when ready.
 *
 * Deprecated API in use, on purpose: `Collection.ruleSet` and the `input` argument of
 * collectionCreate / collectionUpdate. Their replacement (collection "sources", `collection`
 * argument) only exists from Admin API 2026-07, and this project still supports stores pinned to
 * 2026-04. Both are valid through 2027-01. Moving over is on the roadmap; it has to happen before
 * 2026-04 leaves Shopify's supported window. See CONTRIBUTING, "Each quarter".
 */

const QUERY = /* GraphQL */ `
  query Collections($after: String) {
    collections(first: 50, after: $after) {
      nodes {
        id
        handle
        title
        descriptionHtml
        sortOrder
        templateSuffix
        seo { title description }
        ruleSet {
          appliedDisjunctively
          rules {
            column
            relation
            condition
            conditionObject {
              __typename
              ... on CollectionRuleMetafieldCondition { metafieldDefinition { id } }
            }
          }
        }
      }
      ${PAGE_INFO}
    }
  }
`;

const BY_HANDLE = /* GraphQL */ `
  query CollectionByHandle($handle: String!) {
    collectionByIdentifier(identifier: { handle: $handle }) {
      id
      handle
      title
      descriptionHtml
      sortOrder
      templateSuffix
      seo { title description }
      ruleSet {
        appliedDisjunctively
        rules {
          column
          relation
          condition
          conditionObject {
            __typename
            ... on CollectionRuleMetafieldCondition { metafieldDefinition { id } }
          }
        }
      }
    }
  }
`;

interface Node {
  id: string;
  handle: string;
  title: string;
  descriptionHtml: string;
  sortOrder: string;
  templateSuffix: string | null;
  seo: { title: string | null; description: string | null };
  ruleSet: {
    appliedDisjunctively: boolean;
    rules: {
      column: string;
      relation: string;
      condition: string;
      conditionObject: { __typename: string; metafieldDefinition?: { id: string } } | null;
    }[];
  } | null;
}

interface RuleData {
  column: string;
  relation: string;
  condition: string;
  /** Metafield definition the rule filters on (portable ref once mapped). */
  definition?: string;
}

export function normalizeCollection(n: Node): Item {
  return {
    key: n.handle,
    id: n.id,
    data: compact({
      handle: n.handle,
      title: n.title,
      descriptionHtml: n.descriptionHtml || undefined,
      sortOrder: n.sortOrder,
      templateSuffix: n.templateSuffix || undefined,
      seo: compact({ title: n.seo?.title || undefined, description: n.seo?.description || undefined }),
      smart: Boolean(n.ruleSet),
      rules: n.ruleSet
        ? {
            appliedDisjunctively: n.ruleSet.appliedDisjunctively,
            rules: n.ruleSet.rules.map(
              (r): RuleData =>
                compact({
                  column: r.column,
                  relation: r.relation,
                  condition: r.condition,
                  definition: r.conditionObject?.metafieldDefinition?.id,
                }) as RuleData,
            ),
          }
        : undefined,
    }),
  };
}

function input(d: Record<string, unknown>) {
  const rules = d.rules as { appliedDisjunctively: boolean; rules: RuleData[] } | undefined;
  const seo = (d.seo as Record<string, string> | undefined) ?? {};
  return compact({
    handle: d.handle,
    title: d.title,
    descriptionHtml: d.descriptionHtml ?? "",
    sortOrder: d.sortOrder,
    templateSuffix: d.templateSuffix ?? "",
    seo: { title: seo.title ?? "", description: seo.description ?? "" },
    ruleSet: rules
      ? {
          appliedDisjunctively: rules.appliedDisjunctively,
          rules: rules.rules.map((r) => compact({ column: r.column, relation: r.relation, condition: r.condition, conditionObjectId: r.definition })),
        }
      : undefined,
  });
}

export const collections: ResourceAdapter = {
  kind: "collections",
  description:
    "Collections, keyed by handle: title, description, sort order, template, SEO and smart-collection rules. Manual collection membership and sales-channel publishing are not copied, so a new collection is not visible on any channel until someone publishes it.",

  async fetch(client, opts) {
    // A few exact handles (from include patterns or a plan's keys) are looked up directly.
    const k = opts.keys;
    if (k && !k.prefixes.length && k.exact.length && k.exact.length <= 3) {
      const found = await Promise.all(
        k.exact.map(async (handle) => (await client.request<{ collectionByIdentifier: Node | null }>(BY_HANDLE, { handle })).collectionByIdentifier),
      );
      return { items: found.filter((n): n is Node => Boolean(n)).map(normalizeCollection), skipped: [] };
    }
    const nodes = await paginate<Node>(client, QUERY, {}, (d) => d.collections);
    return { items: nodes.map(normalizeCollection), skipped: [] };
  },

  refFor(key) {
    return `${REF_PREFIX}Collection/${key}`;
  },

  parallel: true,

  conflict(source, target) {
    if (source.data.smart !== target.data.smart) {
      return `${source.data.smart ? "smart" : "manual"} in source but ${target.data.smart ? "smart" : "manual"} in target; Shopify can't convert a collection between the two`;
    }
    return undefined;
  },

  async create({ client }, _key, d) {
    const res = await client.request(
      `mutation($input: CollectionInput!) { collectionCreate(input: $input) { collection { id } userErrors { field message } } }`,
      { input: input(d) },
    );
    assertNoUserErrors(res.collectionCreate, `collectionCreate ${String(d.handle)}`);
    return res.collectionCreate.collection.id;
  },

  async update({ client }, target, d) {
    const { handle: _handle, ...rest } = input(d) as Record<string, unknown>;
    const res = await client.request(
      `mutation($input: CollectionInput!) { collectionUpdate(input: $input) { collection { id } userErrors { field message } } }`,
      { input: { id: target.id, ...rest } },
    );
    assertNoUserErrors(res.collectionUpdate, `collectionUpdate ${target.key}`);
  },
};
