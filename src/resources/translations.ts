import { assertNoUserErrors, paginate } from "../shopify/client.js";
import { REF_PREFIX, UNRESOLVED_PREFIX } from "../refs.js";
import type { Item, ResourceAdapter } from "./types.js";
import { reservedPrefix } from "./util.js";

/*
 * Translations of pages, collections, metaobjects, menus and store policies, one item per
 * resource and locale, keyed "<locale>:<Type>/<handle>" (e.g. "fr:Page/shipping").
 *
 * Shopify ties each translation to a digest of the original text it translates. Those digests
 * are store-specific, so translations are registered against the target's own content. They
 * run last in a plan, after pages, collections and metaobjects have been synced.
 */

export const TRANSLATABLE_TYPES = ["PAGE", "COLLECTION", "METAOBJECT", "MENU", "SHOP_POLICY"] as const;

const LOCALES_QUERY = /* GraphQL */ `query Locales { shopLocales { locale primary } }`;

const QUERY = /* GraphQL */ `
  query Translations($type: TranslatableResourceType!, $locale: String!, $after: String) {
    translatableResources(resourceType: $type, first: 50, after: $after) {
      nodes {
        resourceId
        translations(locale: $locale) { key value }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface Node {
  resourceId: string;
  translations: { key: string; value: string | null }[];
}

export const translations: ResourceAdapter = {
  kind: "translations",
  description:
    "Translations of pages, collections, metaobjects, menus and store policies, per locale, keyed locale:Type/handle. Registered against the target's own content. Opt-in (not in the default set).",

  async fetch(client, opts, mapper) {
    const locales =
      opts.locales ??
      (await client.request<{ shopLocales: { locale: string; primary: boolean }[] }>(LOCALES_QUERY)).shopLocales
        .filter((l) => !l.primary)
        .map((l) => l.locale);

    const found: { locale: string; node: Node }[] = [];
    const pairs = TRANSLATABLE_TYPES.flatMap((type) => locales.map((locale) => ({ type, locale })));
    const lists = await Promise.all(pairs.map((v) => paginate<Node>(client, QUERY, v, (d) => d.translatableResources)));
    lists.forEach((nodes, i) => {
      for (const node of nodes) if (node.translations.some((t) => t.value)) found.push({ locale: pairs[i]!.locale, node });
    });

    await mapper.load(found.map((f) => f.node.resourceId));
    const items: Item[] = [];
    const skipped: { key: string; reason: string }[] = [];
    for (const { locale, node } of found) {
      const ref = mapper.map(node.resourceId);
      const name = ref.slice(REF_PREFIX.length);
      const key = `${locale}:${name}`;
      if (ref.startsWith(UNRESOLVED_PREFIX)) {
        skipped.push({ key, reason: "resource can't be matched across stores" });
        continue;
      }
      if (name.startsWith("Metaobject/") && reservedPrefix(name.split("/")[1] ?? "")) {
        skipped.push({ key, reason: "translation of an app-owned or Shopify-reserved metaobject" });
        continue;
      }
      const values = Object.fromEntries(
        node.translations
          .filter((t) => t.value)
          .sort((a, b) => a.key.localeCompare(b.key))
          .map((t) => [t.key, t.value as string]),
      );
      items.push({ key, id: node.resourceId, data: { resource: node.resourceId, locale, values } });
    }
    return { items, skipped };
  },

  async create(ctx, _key, d) {
    await translations.update(ctx, { key: _key, id: "", data: {} }, d);
    return String(d.resource);
  },

  async update({ client }, _target, d) {
    const resourceId = String(d.resource);
    const res = await client.request<{ translatableResource: { translatableContent: { key: string; digest: string | null }[] } | null }>(
      `query($id: ID!) { translatableResource(resourceId: $id) { translatableContent { key digest } } }`,
      { id: resourceId },
    );
    const digests = new Map((res.translatableResource?.translatableContent ?? []).filter((c) => c.digest).map((c) => [c.key, c.digest!]));
    const values = d.values as Record<string, string>;
    const inputs = Object.entries(values)
      .filter(([key]) => digests.has(key))
      .map(([key, value]) => ({ key, value, locale: d.locale, translatableContentDigest: digests.get(key) }));
    const missing = Object.keys(values).filter((k) => !digests.has(k));

    if (inputs.length) {
      const out = await client.request(
        `mutation($id: ID!, $t: [TranslationInput!]!) { translationsRegister(resourceId: $id, translations: $t) { translations { key } userErrors { field message code } } }`,
        { id: resourceId, t: inputs },
      );
      assertNoUserErrors(out.translationsRegister, `translationsRegister ${String(d.locale)}`);
    }
    if (missing.length) {
      throw new Error(
        `registered ${inputs.length} of ${Object.keys(values).length} fields; the target has no original text for: ${missing.join(", ")}`,
      );
    }
  },
};
