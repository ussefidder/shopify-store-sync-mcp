import { assertNoUserErrors, paginate, type AdminClient } from "../shopify/client.js";
import type { ResourceAdapter } from "./types.js";
import { compact, PAGE_INFO } from "./util.js";

/*
 * Markets, keyed by handle: name, status, countries, currency settings, price inclusions (taxes and
 * duties) and web presences (domains or subfolders, with their languages). Only region markets
 * (countries) are synced; markets for B2B company locations, retail locations or channels are
 * reported as skipped.
 *
 * Nothing is removed: countries and web presences that only the target has stay on the target market.
 * A web presence is matched by subfolder (/fr) or domain host; a missing subfolder is created in the
 * target, a missing domain can't be (domains are connected by hand) and is reported.
 */

const QUERY = /* GraphQL */ `
  query Markets($after: String) {
    markets(first: 50, after: $after) {
      nodes {
        id
        handle
        name
        type
        status
        conditions {
          regionsCondition {
            applicationLevel
            regions(first: 250) { nodes { ... on MarketRegionCountry { code } } }
          }
        }
        currencySettings { baseCurrency { currencyCode } localCurrencies roundingEnabled }
        priceInclusions { inclusiveDutiesPricingStrategy inclusiveTaxPricingStrategy }
        webPresences(first: 20) {
          nodes { id subfolderSuffix domain { host } defaultLocale { locale } alternateLocales { locale } }
        }
      }
      ${PAGE_INFO}
    }
  }
`;

interface WebPresenceNode {
  id: string;
  subfolderSuffix: string | null;
  domain: { host: string } | null;
  defaultLocale: { locale: string };
  alternateLocales: { locale: string }[];
}

interface Node {
  id: string;
  handle: string;
  name: string;
  type: string;
  status: string;
  conditions: { regionsCondition: { applicationLevel: string | null; regions: { nodes: { code?: string }[] } } | null } | null;
  currencySettings: { baseCurrency: { currencyCode: string }; localCurrencies: boolean; roundingEnabled: boolean } | null;
  priceInclusions: { inclusiveDutiesPricingStrategy: string; inclusiveTaxPricingStrategy: string } | null;
  webPresences: { nodes: WebPresenceNode[] };
}

export interface WebPresence {
  subfolderSuffix?: string;
  domain?: string;
  defaultLocale: string;
  alternateLocales: string[];
}

function webPresence(n: WebPresenceNode): WebPresence {
  return compact({
    subfolderSuffix: n.subfolderSuffix ?? undefined,
    domain: n.subfolderSuffix ? undefined : n.domain?.host,
    defaultLocale: n.defaultLocale.locale,
    alternateLocales: n.alternateLocales.map((l) => l.locale).sort(),
  }) as WebPresence;
}

const presenceKey = (w: WebPresence) => (w.subfolderSuffix ? `/${w.subfolderSuffix}` : (w.domain ?? ""));

export function normalizeMarket(n: Node): Record<string, unknown> {
  const rc = n.conditions?.regionsCondition;
  return compact({
    name: n.name,
    status: n.status,
    regions: rc?.applicationLevel === "ALL" ? ["*"] : (rc?.regions.nodes.map((r) => r.code).filter((c): c is string => Boolean(c)) ?? []).sort(),
    currency: n.currencySettings
      ? { baseCurrency: n.currencySettings.baseCurrency.currencyCode, localCurrencies: n.currencySettings.localCurrencies, roundingEnabled: n.currencySettings.roundingEnabled }
      : undefined,
    priceInclusions: n.priceInclusions
      ? { duties: n.priceInclusions.inclusiveDutiesPricingStrategy, taxes: n.priceInclusions.inclusiveTaxPricingStrategy }
      : undefined,
    webPresences: n.webPresences.nodes.map(webPresence).sort((a, b) => presenceKey(a).localeCompare(presenceKey(b))),
  });
}

/** Market handle -> id in a store, for the adapters that point at markets. */
const MARKET_IDS = /* GraphQL */ `query MarketIds($after: String) { markets(first: 250, after: $after) { nodes { id handle } ${PAGE_INFO} } }`;
export async function marketIds(client: AdminClient): Promise<Map<string, string>> {
  return new Map((await paginate<{ id: string; handle: string }>(client, MARKET_IDS, {}, (d) => d.markets)).map((m) => [m.handle, m.id]));
}

const WEB_PRESENCES = /* GraphQL */ `
  query WebPresences($after: String) {
    webPresences(first: 50, after: $after) { nodes { id subfolderSuffix domain { host } defaultLocale { locale } alternateLocales { locale } } ${PAGE_INFO} }
  }
`;

/** Ids in the target of the web presences `wanted`, creating subfolders that are missing. Domains that are missing are returned as such. */
async function presenceIds(client: AdminClient, wanted: WebPresence[]): Promise<{ ids: string[]; missing: string[] }> {
  if (!wanted.length) return { ids: [], missing: [] };
  const existing = await paginate<WebPresenceNode>(client, WEB_PRESENCES, {}, (d) => d.webPresences);
  const byKey = new Map(existing.map((n) => [presenceKey(webPresence(n)), n.id]));
  const ids: string[] = [];
  const missing: string[] = [];
  for (const w of wanted) {
    const id = byKey.get(presenceKey(w));
    if (id) ids.push(id);
    else if (w.subfolderSuffix) {
      const res = await client.request(
        `mutation WebPresenceCreate($input: WebPresenceCreateInput!) { webPresenceCreate(input: $input) { webPresence { id } userErrors { field message code } } }`,
        { input: { subfolderSuffix: w.subfolderSuffix, defaultLocale: w.defaultLocale, alternateLocales: w.alternateLocales } },
      );
      assertNoUserErrors(res.webPresenceCreate, `webPresenceCreate /${w.subfolderSuffix}`);
      ids.push(res.webPresenceCreate.webPresence.id);
    } else missing.push(w.domain ?? "?");
  }
  return { ids, missing };
}

function currencyInput(d: Record<string, unknown>) {
  const c = d.currency as { baseCurrency: string; localCurrencies: boolean; roundingEnabled: boolean } | undefined;
  return c ? { baseCurrency: c.baseCurrency, localCurrencies: c.localCurrencies, roundingEnabled: c.roundingEnabled } : undefined;
}

function inclusionsInput(d: Record<string, unknown>) {
  const p = d.priceInclusions as { duties: string; taxes: string } | undefined;
  return p ? { dutiesPricingStrategy: p.duties, taxPricingStrategy: p.taxes } : undefined;
}

const regionsInput = (codes: string[]) => (codes.includes("*") ? { applicationLevel: "ALL" } : { regions: codes.map((countryCode) => ({ countryCode })) });

const missingDomains = (key: string, missing: string[]) =>
  new Error(`market ${key}: written, but domain(s) ${missing.join(", ")} aren't connected to the target; connect them in Settings > Domains, then plan again`);

export const markets: ResourceAdapter = {
  kind: "markets",
  description:
    "Markets (countries), keyed by handle: name, status, countries, currency settings, tax and duty price inclusions, and web presences (subfolders or domains, with languages). Countries and web presences only the target has are kept. B2B, location and channel markets are not synced. Opt-in.",

  async fetch(client) {
    const nodes = await paginate<Node>(client, QUERY, {}, (d) => d.markets);
    const skipped = nodes.filter((n) => n.type !== "REGION").map((n) => ({ key: n.handle, reason: `${n.type.toLowerCase().replace("_", " ")} market (only country markets are synced)` }));
    return { items: nodes.filter((n) => n.type === "REGION").map((n) => ({ key: n.handle, id: n.id, data: normalizeMarket(n) })), skipped };
  },

  refFor: (key) => `shopify://Market/${key}`,

  /** Countries and web presences only the target has are kept, so they aren't differences. */
  alignTarget(source, target) {
    const regions = (source.regions as string[]) ?? [];
    const presences = new Set(((source.webPresences as WebPresence[]) ?? []).map(presenceKey));
    return {
      ...target,
      regions: ((target.regions as string[]) ?? []).filter((r) => regions.includes(r)),
      webPresences: ((target.webPresences as WebPresence[]) ?? []).filter((w) => presences.has(presenceKey(w))),
    };
  },

  async create({ client }, key, d) {
    const { ids, missing } = await presenceIds(client, (d.webPresences as WebPresence[]) ?? []);
    const res = await client.request(
      `mutation MarketCreate($input: MarketCreateInput!) { marketCreate(input: $input) { market { id } userErrors { field message code } } }`,
      {
        input: compact({
          name: d.name,
          handle: key,
          status: d.status,
          conditions: { regionsCondition: regionsInput((d.regions as string[]) ?? []) },
          currencySettings: currencyInput(d),
          priceInclusions: inclusionsInput(d),
          webPresences: ids.length ? ids : undefined,
        }),
      },
    );
    assertNoUserErrors(res.marketCreate, `marketCreate ${key}`);
    if (missing.length) throw missingDomains(key, missing);
    return res.marketCreate.market.id;
  },

  async update({ client }, target, d) {
    const have = new Set((target.data.regions as string[]) ?? []);
    const add = ((d.regions as string[]) ?? []).filter((r) => !have.has(r));
    const havePresences = new Set(((target.data.webPresences as WebPresence[]) ?? []).map(presenceKey));
    const { ids, missing } = await presenceIds(client, ((d.webPresences as WebPresence[]) ?? []).filter((w) => !havePresences.has(presenceKey(w))));
    const res = await client.request(
      `mutation MarketUpdate($id: ID!, $input: MarketUpdateInput!) { marketUpdate(id: $id, input: $input) { market { id } userErrors { field message code } } }`,
      {
        id: target.id,
        input: compact({
          name: d.name,
          status: d.status,
          conditions: add.length ? { conditionsToAdd: { regionsCondition: regionsInput(add) } } : undefined,
          currencySettings: currencyInput(d),
          priceInclusions: inclusionsInput(d),
          webPresencesToAdd: ids.length ? ids : undefined,
        }),
      },
    );
    assertNoUserErrors(res.marketUpdate, `marketUpdate ${target.key}`);
    if (missing.length) throw missingDomains(target.key, missing);
  },
};
