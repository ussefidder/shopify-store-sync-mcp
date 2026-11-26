import type { RefToGidResolver as Resolver } from "../refs.js";
import { assertNoUserErrors, paginate, type AdminClient } from "../shopify/client.js";
import { compact, PAGE_INFO } from "./util.js";

/*
 * Shopify's collection "sources" (Admin API 2026-07 and later): what a collection is made of,
 * beyond the rules the deprecated ruleSet can express.
 *
 *   exclusions        products left out of a collection: by tag, type, vendor, category, or by
 *                     being in another collection
 *   subCollections    a collection made of other collections
 *   sourceConditions  conditions that only exist in the new model (product status, category,
 *                     metaobject values...) on a collection that has no ruleSet
 *
 * Read and written only on stores on 2026-07 or later; a store pinned to an older version keeps
 * the ruleSet behaviour. Nothing is removed: a condition, an excluded product rule or a
 * sub-collection only the target has stays.
 *
 * Manual membership (the products picked by hand) is separate: products, opt-in, any version.
 */

const CATEGORY_GID = "gid://shopify/TaxonomyCategory/";

export const supportsSources = (apiVersion: string) => apiVersion >= "2026-07";

/*
 * Each condition type has its own enum for `relation` and its own type for `value(s)`, and GraphQL
 * won't merge same-named fields of different types, so every one is read under an alias with its
 * type: relation__ProductTag, values__ProductTag... normalizeCondition strips the suffix.
 */
const INCLUSION_FIELDS = /* GraphQL */ `
  __typename
  ... on CollectionSourceInclusionConditionMetafieldBoolean { relation__MetafieldBoolean: relation value__MetafieldBoolean: value definition { id } }
  ... on CollectionSourceInclusionConditionMetafieldDecimal { relation__MetafieldDecimal: relation value__MetafieldDecimal: value definition { id } }
  ... on CollectionSourceInclusionConditionMetafieldInt { relation__MetafieldInt: relation value__MetafieldInt: value definition { id } }
  ... on CollectionSourceInclusionConditionMetafieldMetaobject { relation__MetafieldMetaobject: relation value__MetafieldMetaobject: value { id } definition { id } }
  ... on CollectionSourceInclusionConditionMetafieldMetaobjectList { matchType relation__MetafieldMetaobjectList: relation values__MetafieldMetaobjectList: values { id } definition { id } }
  ... on CollectionSourceInclusionConditionMetafieldString { matchType relation__MetafieldString: relation values__MetafieldString: values definition { id } }
  ... on CollectionSourceInclusionConditionMetafieldStringList { matchType relation__MetafieldStringList: relation values__MetafieldStringList: values definition { id } }
  ... on CollectionSourceInclusionConditionProductCategory { matchType relation__ProductCategory: relation values__ProductCategory: values { category { id } includeDescendants } }
  ... on CollectionSourceInclusionConditionProductStatus { matchType relation__ProductStatus: relation values__ProductStatus: values }
  ... on CollectionSourceInclusionConditionProductTag { matchType relation__ProductTag: relation values__ProductTag: values }
  ... on CollectionSourceInclusionConditionProductTitle { matchType relation__ProductTitle: relation values__ProductTitle: values }
  ... on CollectionSourceInclusionConditionProductType { matchType relation__ProductType: relation values__ProductType: values }
  ... on CollectionSourceInclusionConditionProductVendor { matchType relation__ProductVendor: relation values__ProductVendor: values }
  ... on CollectionSourceInclusionConditionVariantTitle { matchType relation__VariantTitle: relation values__VariantTitle: values }
  ... on CollectionSourceInclusionConditionVariantPrice { relation__VariantPrice: relation value__VariantPrice: value { amount currencyCode } }
  ... on CollectionSourceInclusionConditionVariantCompareAtPrice { relation__VariantCompareAtPrice: relation value__VariantCompareAtPrice: value { amount currencyCode } }
  ... on CollectionSourceInclusionConditionVariantInventory { relation__VariantInventory: relation value__VariantInventory: value }
  ... on CollectionSourceInclusionConditionVariantWeight { relation__VariantWeight: relation value__VariantWeight: value { unit value } }
`;

const EXCLUSION_FIELDS = /* GraphQL */ `
  __typename
  ... on CollectionSourceExclusionConditionCollection { matchType values__Collection: values { id } }
  ... on CollectionSourceExclusionConditionProductCategory { matchType relation__ProductCategory: relation values__ProductCategory: values { category { id } includeDescendants } }
  ... on CollectionSourceExclusionConditionProductTag { matchType relation__ProductTag: relation values__ProductTag: values }
  ... on CollectionSourceExclusionConditionProductType { matchType relation__ProductType: relation values__ProductType: values }
  ... on CollectionSourceExclusionConditionProductVendor { matchType relation__ProductVendor: relation values__ProductVendor: values }
`;

const SOURCE_FIELDS = /* GraphQL */ `
  __typename
  id
  title
  ... on CollectionConditionsSource {
    inclusion { matchType conditions { ${INCLUSION_FIELDS} } }
    exclusion { matchType conditions { ${EXCLUSION_FIELDS} } }
  }
  ... on CollectionSubCollectionsSource { collections { id } }
`;

const SOURCES = /* GraphQL */ `
  query CollectionSources($after: String) {
    collections(first: 50, after: $after) { nodes { id handle sources { ${SOURCE_FIELDS} } } ${PAGE_INFO} }
  }
`;

const SOURCES_BY_HANDLE = /* GraphQL */ `
  query CollectionSourcesByHandle($handle: String!) { collectionByIdentifier(identifier: { handle: $handle }) { id handle sources { ${SOURCE_FIELDS} } } }
`;

const SOURCES_OF = /* GraphQL */ `
  query CollectionSourcesOf($id: ID!) { collection(id: $id) { id sources { ${SOURCE_FIELDS} } } }
`;

type Raw = Record<string, any>;

export interface Condition {
  /** The input field name: productTag, metafieldString, collection... */
  type: string;
  matchType?: string;
  relation?: string;
  /** Metafield definition (a gid in a store, a ref once mapped). */
  definition?: string;
  value?: unknown;
  values?: unknown[];
}

export interface ConditionGroup {
  matchType?: string;
  conditions: Condition[];
}

export interface SourcesData {
  exclusions?: ConditionGroup;
  subCollections?: string[];
  sourceConditions?: ConditionGroup;
}

const typeOf = (typename: string) => {
  const m = /^CollectionSource(?:Inclusion|Exclusion)Condition(.+)$/.exec(typename);
  return m ? m[1]!.charAt(0).toLowerCase() + m[1]!.slice(1) : undefined;
};

export function normalizeCondition(c: Raw): Condition | undefined {
  const type = typeOf(String(c.__typename));
  if (!type || type === "unknown") return undefined;
  const get = (name: string) => {
    const k = Object.keys(c).find((x) => x === name || x.startsWith(`${name}__`));
    return k ? c[k] : undefined;
  };
  const value = get("value");
  const values = get("values") as unknown[] | undefined;
  const relation = get("relation") as string | undefined;
  const flat = (v: unknown) => {
    // Shopify's taxonomy is the same in every store: the category id is kept without its gid prefix, like products do.
    if (v && typeof v === "object" && "category" in (v as Raw)) return { category: String((v as Raw).category.id).replace(CATEGORY_GID, ""), includeDescendants: (v as Raw).includeDescendants };
    if (v && typeof v === "object" && "id" in (v as Raw) && Object.keys(v as Raw).length === 1) return (v as Raw).id;
    return v;
  };
  return compact({
    type,
    matchType: c.matchType ?? undefined,
    relation: relation ?? undefined,
    definition: c.definition?.id,
    value: value === undefined ? undefined : flat(value),
    values: values?.map(flat),
  }) as Condition;
}

/** Conditions in a stable order, so two stores list them alike. */
const sortConditions = (cs: Condition[]) => [...cs].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

function group(g: Raw | null | undefined): ConditionGroup | undefined {
  const conditions = (g?.conditions ?? []).map(normalizeCondition).filter((c: Condition | undefined): c is Condition => Boolean(c));
  return conditions.length ? { matchType: g?.matchType ?? undefined, conditions: sortConditions(conditions) } : undefined;
}

export function normalizeSources(sources: Raw[], hasRuleSet: boolean): SourcesData {
  const conds = sources.filter((s) => s.__typename === "CollectionConditionsSource");
  const subs = sources.filter((s) => s.__typename === "CollectionSubCollectionsSource");
  const exclusions = group({ matchType: conds[0]?.exclusion?.matchType, conditions: conds.flatMap((s) => s.exclusion?.conditions ?? []) });
  const inclusion = group({ matchType: conds[0]?.inclusion?.matchType, conditions: conds.flatMap((s) => s.inclusion?.conditions ?? []) });
  const subCollections = subs.flatMap((s) => (s.collections ?? []).map((c: Raw) => c.id as string));
  return compact({
    exclusions,
    subCollections: subCollections.length ? subCollections : undefined,
    // With a ruleSet, the inclusion conditions are those rules, already compared as `rules`.
    sourceConditions: hasRuleSet ? undefined : inclusion,
  }) as SourcesData;
}

/** Sources of every collection (or the handles asked for), by handle. */
export async function readSources(client: AdminClient, handles?: Set<string>): Promise<Map<string, Raw[]>> {
  if (handles && handles.size <= 3) {
    const found = await Promise.all(
      [...handles].map(async (handle) => (await client.request<{ collectionByIdentifier: { handle: string; sources?: Raw[] } | null }>(SOURCES_BY_HANDLE, { handle })).collectionByIdentifier),
    );
    return new Map(found.filter((n): n is { handle: string; sources?: Raw[] } => Boolean(n)).map((n) => [n.handle, n.sources ?? []]));
  }
  const nodes = await paginate<{ handle: string; sources: Raw[] }>(client, SOURCES, {}, (d) => d.collections);
  return new Map(nodes.filter((n) => !handles || handles.has(n.handle)).map((n) => [n.handle, n.sources]));
}

const key = (c: Condition) => JSON.stringify(c);

/** What only the target has stays, so it isn't a difference. */
export function alignSources(source: Record<string, unknown>, target: Record<string, unknown>): Record<string, unknown> {
  const out = { ...target };
  for (const f of ["exclusions", "sourceConditions"] as const) {
    const s = source[f] as ConditionGroup | undefined;
    const t = target[f] as ConditionGroup | undefined;
    if (!t) continue;
    const wanted = new Set((s?.conditions ?? []).map(key));
    const kept = t.conditions.filter((c) => wanted.has(key(c)));
    if (kept.length) out[f] = { matchType: s?.matchType ?? t.matchType, conditions: kept };
    else delete out[f];
  }
  if (target.subCollections) {
    const wanted = new Set((source.subCollections as string[]) ?? []);
    const kept = (target.subCollections as string[]).filter((c) => wanted.has(c));
    if (kept.length) out.subCollections = kept;
    else delete out.subCollections;
  }
  return out;
}

function conditionInput(c: Condition): Record<string, unknown> {
  const shape = (v: unknown) => (v && typeof v === "object" && "category" in (v as Raw) ? { categoryId: `${CATEGORY_GID}${(v as Raw).category}`, includeDescendants: (v as Raw).includeDescendants } : v);
  return {
    [c.type]: compact({
      matchType: c.matchType,
      relation: c.relation,
      definitionId: c.definition,
      value: c.value === undefined ? undefined : shape(c.value),
      values: c.values?.map(shape),
    }),
  };
}

/**
 * Bring a target collection's sources in line with `d` (refs already rewritten to the target's
 * ids): conditions, exclusions and sub-collections it lacks are added, nothing is removed.
 */
export async function writeSources(client: AdminClient, collectionId: string, d: Record<string, unknown>): Promise<void> {
  const wantEx = d.exclusions as ConditionGroup | undefined;
  const wantIn = d.sourceConditions as ConditionGroup | undefined;
  const wantSubs = (d.subCollections as string[] | undefined) ?? [];
  if (!wantEx && !wantIn && !wantSubs.length) return;

  const res = await client.request<{ collection: { sources: Raw[] } | null }>(SOURCES_OF, { id: collectionId });
  const sources = res.collection?.sources ?? [];
  const have = normalizeSources(sources, false);
  const cond = sources.find((s) => s.__typename === "CollectionConditionsSource");
  const sub = sources.find((s) => s.__typename === "CollectionSubCollectionsSource");
  const missing = (want: ConditionGroup | undefined, got: ConditionGroup | undefined) => {
    const seen = new Set((got?.conditions ?? []).map(key));
    return (want?.conditions ?? []).filter((c) => !seen.has(key(c)));
  };
  const addIn = missing(wantIn, have.sourceConditions);
  const addEx = missing(wantEx, have.exclusions);
  const addSubs = wantSubs.filter((c) => !(have.subCollections ?? []).includes(c));

  const toCreate: Record<string, unknown>[] = [];
  const toUpdate: Record<string, unknown>[] = [];
  if (addIn.length || addEx.length) {
    const inclusion = addIn.length ? compact({ matchType: wantIn?.matchType, conditions: addIn.map(conditionInput) }) : undefined;
    const exclusion = addEx.length ? compact({ matchType: wantEx?.matchType, conditions: addEx.map(conditionInput) }) : undefined;
    if (cond) {
      toUpdate.push({
        condition: compact({
          id: cond.id,
          inclusion: inclusion ? { matchType: inclusion.matchType, conditionsToCreate: inclusion.conditions } : undefined,
          exclusion: exclusion ? { matchType: exclusion.matchType, conditionsToCreate: exclusion.conditions } : undefined,
        }),
      });
    } else toCreate.push({ source: compact({ title: "Conditions", inclusion, exclusion }) });
  }
  if (addSubs.length) {
    if (sub) toUpdate.push({ subCollections: { id: sub.id, collectionIds: [...new Set([...(have.subCollections ?? []), ...addSubs])] } });
    else toCreate.push({ subCollections: { title: "Collections", collectionIds: addSubs } });
  }
  if (!toCreate.length && !toUpdate.length) return;
  const out = await client.request(
    `mutation CollectionSources($collection: CollectionUpdateInput!) { collectionUpdate(collection: $collection) { collection { id } userErrors { field message } } }`,
    { collection: compact({ id: collectionId, sourcesToCreate: toCreate.length ? toCreate : undefined, sourcesToUpdate: toUpdate.length ? toUpdate : undefined }) },
  );
  assertNoUserErrors(out.collectionUpdate, "collectionUpdate (sources)");
}

/** Products picked by hand into a manual collection, by handle. */
export async function manualProducts(client: AdminClient, collectionId: string): Promise<string[]> {
  const nodes = await paginate<{ handle: string }>(
    client,
    `query CollectionProducts($id: ID!, $after: String) { collection(id: $id) { products(first: 250, after: $after) { nodes { handle } ${PAGE_INFO} } } }`,
    { id: collectionId },
    (d) => d.collection.products,
  );
  return nodes.map((n) => n.handle).sort();
}

/** Add products to a manual collection; returns the handles the target doesn't have. */
export async function addProducts(client: AdminClient, resolver: Resolver, collectionId: string, handles: string[]): Promise<string[]> {
  if (!handles.length) return [];
  const refs = handles.map((h) => `shopify://Product/${h}`);
  await resolver.prefetch(refs);
  const ids: string[] = [];
  const missing: string[] = [];
  for (const [i, ref] of refs.entries()) {
    const id = await resolver.resolve(ref);
    if (id) ids.push(id);
    else missing.push(handles[i]!);
  }
  if (supportsSources(client.store.apiVersion)) {
    const res = await client.request<{ collection: { sources: Raw[] } | null }>(SOURCES_OF, { id: collectionId });
    const cond = res.collection?.sources.find((s) => s.__typename === "CollectionConditionsSource");
    for (let i = 0; i < ids.length; i += 250) {
      const selections = ids.slice(i, i + 250).map((productId) => ({ productId }));
      const collection = cond
        ? { id: collectionId, sourcesToUpdate: [{ condition: { id: cond.id, inclusion: { selectionsToAdd: selections } } }] }
        : { id: collectionId, sourcesToCreate: [{ source: { title: "Products", inclusion: { selections } } }] };
      const out = await client.request(
        `mutation CollectionSelections($collection: CollectionUpdateInput!) { collectionUpdate(collection: $collection) { collection { id } userErrors { field message } } }`,
        { collection },
      );
      assertNoUserErrors(out.collectionUpdate, "collectionUpdate (products)");
    }
  } else {
    for (let i = 0; i < ids.length; i += 250) {
      const out = await client.request(
        `mutation CollectionAddProducts($id: ID!, $ids: [ID!]!) { collectionAddProducts(id: $id, productIds: $ids) { collection { id } userErrors { field message } } }`,
        { id: collectionId, ids: ids.slice(i, i + 250) },
      );
      assertNoUserErrors(out.collectionAddProducts, "collectionAddProducts");
    }
  }
  return missing;
}
