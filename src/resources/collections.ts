import { assertNoUserErrors, paginate, type AdminClient } from "../shopify/client.js";
import { REF_PREFIX, type RefToGidResolver } from "../refs.js";
import type { FetchOptions, Item, ResourceAdapter } from "./types.js";
import { addProducts, alignSources, manualProducts, normalizeSources, readSources, supportsSources, writeSources } from "./collectionSources.js";
import { compact, PAGE_INFO } from "./util.js";

/*
 * Collections: title, description, sort order, template, SEO and, for smart collections,
 * their rules. On Admin API 2026-07 and later, also what Shopify's collection sources add:
 * exclusions, sub-collections, and conditions a ruleSet can't express (collectionSources.ts).
 * Manual membership (products picked by hand) only with the collection_products option, added
 * and never removed. Publishing is the sales_channels resource's job.
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
    "Collections, keyed by handle: title, description, sort order, template, SEO and smart-collection rules; on Admin API 2026-07+, also exclusions, sub-collections and conditions only Shopify's new collection sources hold. Products picked by hand into manual collections only with collection_products (added, never removed). Publishing is synced by sales_channels.",

  async fetch(client, opts) {
    // A few exact handles (from include patterns or a plan's keys) are looked up directly.
    const k = opts.keys;
    if (k && !k.prefixes.length && k.exact.length && k.exact.length <= 3) {
      const found = await Promise.all(
        k.exact.map(async (handle) => (await client.request<{ collectionByIdentifier: Node | null }>(BY_HANDLE, { handle })).collectionByIdentifier),
      );
      return { items: await extras(client, opts, found.filter((n): n is Node => Boolean(n)).map(normalizeCollection)), skipped: [] };
    }
    const nodes = await paginate<Node>(client, QUERY, {}, (d) => d.collections);
    return { items: await extras(client, opts, nodes.map(normalizeCollection)), skipped: [] };
  },

  alignTarget(source, target) {
    const out = alignSources(source, target);
    if (target.products) {
      const wanted = new Set((source.products as string[]) ?? []);
      const kept = (target.products as string[]).filter((h) => wanted.has(h));
      if (kept.length) out.products = kept;
      else delete out.products;
    }
    return out;
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

  async create({ client, resolver }, _key, d) {
    const res = await client.request(
      `mutation($input: CollectionInput!) { collectionCreate(input: $input) { collection { id } userErrors { field message } } }`,
      { input: input(d) },
    );
    assertNoUserErrors(res.collectionCreate, `collectionCreate ${String(d.handle)}`);
    const id = res.collectionCreate.collection.id as string;
    await afterWrite(client, resolver, id, String(d.handle), d);
    return id;
  },

  async update({ client, resolver }, target, d) {
    const { handle: _handle, ...rest } = input(d) as Record<string, unknown>;
    const res = await client.request(
      `mutation($input: CollectionInput!) { collectionUpdate(input: $input) { collection { id } userErrors { field message } } }`,
      { input: { id: target.id, ...rest } },
    );
    assertNoUserErrors(res.collectionUpdate, `collectionUpdate ${target.key}`);
    const have = new Set((target.data.products as string[]) ?? []);
    await afterWrite(client, resolver, target.id, target.key, { ...d, products: ((d.products as string[]) ?? []).filter((h) => !have.has(h)) });
  },
};

/** Sources (exclusions, sub-collections, source-only conditions) and hand-picked products. */
async function extras(client: AdminClient, opts: FetchOptions, items: Item[]): Promise<Item[]> {
  if (supportsSources(client.store.apiVersion) && items.length) {
    const sources = await readSources(client, new Set(items.map((i) => i.key)));
    for (const it of items) {
      const extra = normalizeSources(sources.get(it.key) ?? [], Boolean(it.data.rules));
      // Conditions only the new model holds make a collection automated, like a ruleSet does.
      it.data = { ...it.data, ...extra, ...(extra.sourceConditions ? { smart: true } : {}) };
    }
  }
  if (opts.collectionProducts) {
    // Only collections made of hand-picked products: a sub-collection's products come from its collections.
    for (const it of items) {
      if (it.data.smart || it.data.subCollections) continue;
      const products = await manualProducts(client, it.id);
      if (products.length) it.data = { ...it.data, products };
    }
  }
  return items;
}

async function afterWrite(client: AdminClient, resolver: RefToGidResolver, id: string, handle: string, d: Record<string, unknown>): Promise<void> {
  if (supportsSources(client.store.apiVersion)) await writeSources(client, id, d);
  const missing = await addProducts(client, resolver, id, (d.products as string[]) ?? []);
  if (missing.length) {
    throw new Error(`collection ${handle} written, but ${missing.length} product(s) it holds aren't in the target: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", ..." : ""}`);
  }
}
