import { variantRef } from "../refs.js";
import { assertNoUserErrors, paginate, type AdminClient } from "../shopify/client.js";
import type { Item, ResourceAdapter } from "./types.js";
import { compact, PAGE_INFO } from "./util.js";

/*
 * Market catalogs, keyed by title: status, the markets they apply to, and their price list
 * (currency, percentage adjustment, compare-at mode). With prices on, fixed prices per variant are
 * compared and copied too. Sales-channel catalogs belong to their app and B2B catalogs to company
 * locations; neither is synced here.
 *
 * Which products a catalog includes is synced by the sales_channels resource, like a sales channel:
 * a catalog created here starts empty, and the plan warns when sales_channels isn't part of it.
 * Markets only the target links are kept on its catalog. A price list in a currency the target
 * doesn't sell in is refused before anything is written.
 */

const QUERY = /* GraphQL */ `
  query Catalogs($after: String) {
    catalogs(first: 50, after: $after, type: MARKET) {
      nodes {
        id
        title
        status
        ... on MarketCatalog { markets(first: 100) { nodes { handle } } }
        priceList {
          id
          currency
          fixedPricesCount
          parent { adjustment { type value } settings { compareAtMode } }
        }
        publication { id autoPublish }
      }
      ${PAGE_INFO}
    }
  }
`;

const PRICES = /* GraphQL */ `
  query PriceListPrices($id: ID!, $after: String) {
    priceList(id: $id) {
      prices(first: 250, after: $after, originType: FIXED) {
        nodes {
          price { amount }
          compareAtPrice { amount }
          variant { product { handle } selectedOptions { name value } }
        }
        ${PAGE_INFO}
      }
    }
  }
`;

interface Node {
  id: string;
  title: string;
  status: string;
  markets?: { nodes: { handle: string }[] };
  priceList: {
    id: string;
    currency: string;
    fixedPricesCount: number;
    parent: { adjustment: { type: string; value: number }; settings: { compareAtMode: string } } | null;
  } | null;
  publication: { id: string; autoPublish: boolean } | null;
}

interface PriceNode {
  price: { amount: string };
  compareAtPrice: { amount: string } | null;
  variant: { product: { handle: string }; selectedOptions: { name: string; value: string }[] };
}

export interface FixedPrice {
  variant: string;
  price: string;
  compareAtPrice?: string;
}

/** 10.0 and 10.00 are the same price. */
const amount = (s: string | undefined) => (s === undefined ? undefined : String(Number(s)));
const marketRef = (handle: string) => `shopify://Market/${handle}`;

async function fixedPrices(client: AdminClient, priceListId: string): Promise<FixedPrice[]> {
  const nodes = await paginate<PriceNode>(client, PRICES, { id: priceListId }, (d) => d.priceList.prices);
  return nodes
    .map((n) => compact({ variant: variantRef(n.variant.product.handle, n.variant.selectedOptions), price: amount(n.price.amount)!, compareAtPrice: amount(n.compareAtPrice?.amount) }) as FixedPrice)
    .sort((a, b) => a.variant.localeCompare(b.variant));
}

const CATALOG_PARTS = /* GraphQL */ `query CatalogParts($id: ID!) { catalog(id: $id) { priceList { id } publication { id } } }`;

function priceListParent(p: { adjustment: { type: string; value: number }; compareAtMode: string }) {
  return { adjustment: { type: p.adjustment.type, value: p.adjustment.value }, settings: { compareAtMode: p.compareAtMode } };
}

async function addFixedPrices(client: AdminClient, priceListId: string, currency: string, prices: FixedPrice[]): Promise<void> {
  for (let i = 0; i < prices.length; i += 250) {
    const res = await client.request(
      `mutation PriceListFixedPricesAdd($id: ID!, $prices: [PriceListPriceInput!]!) { priceListFixedPricesAdd(priceListId: $id, prices: $prices) { prices { price { amount } } userErrors { field message code } } }`,
      {
        id: priceListId,
        prices: prices.slice(i, i + 250).map((p) =>
          compact({
            variantId: p.variant,
            price: { amount: p.price, currencyCode: currency },
            compareAtPrice: p.compareAtPrice ? { amount: p.compareAtPrice, currencyCode: currency } : undefined,
          }),
        ),
      },
    );
    assertNoUserErrors(res.priceListFixedPricesAdd, "priceListFixedPricesAdd");
  }
}

type PriceListData = { currency: string; adjustment: { type: string; value: number }; compareAtMode: string };

/** Refuse before writing anything when the target can't sell in the price list's currency (a catalog without its prices would be worse). */
async function checkCurrency(client: AdminClient, title: string, d: Record<string, unknown>): Promise<void> {
  const pl = d.priceList as PriceListData | undefined;
  if (!pl) return;
  const { shop } = await client.request<{ shop: { currencyCode: string; enabledPresentmentCurrencies: string[] } }>(
    `query ShopCurrencies { shop { currencyCode enabledPresentmentCurrencies } }`,
  );
  if (pl.currency !== shop.currencyCode && !shop.enabledPresentmentCurrencies.includes(pl.currency)) {
    throw new Error(
      `catalog ${title}: its price list is in ${pl.currency}, which the target doesn't sell in (store currency ${shop.currencyCode}${shop.enabledPresentmentCurrencies.length > 1 ? `, also ${shop.enabledPresentmentCurrencies.filter((c) => c !== shop.currencyCode).join(", ")}` : ""}); enable ${pl.currency} in the target's payments settings first. Nothing was written.`,
    );
  }
}

/** The price list and publication of a catalog, created or brought in line with `d`. */
async function writeParts(client: AdminClient, catalogId: string, title: string, d: Record<string, unknown>, existing: { priceList?: string; publication?: string }) {
  const pl = d.priceList as PriceListData | undefined;
  let priceListId = existing.priceList;
  if (pl && !priceListId) {
    const res = await client.request(
      `mutation PriceListCreate($input: PriceListCreateInput!) { priceListCreate(input: $input) { priceList { id } userErrors { field message code } } }`,
      { input: { name: title, currency: pl.currency, catalogId, parent: priceListParent(pl) } },
    );
    assertNoUserErrors(res.priceListCreate, `priceListCreate ${title}`);
    priceListId = res.priceListCreate.priceList.id as string;
  } else if (pl && priceListId) {
    const res = await client.request(
      `mutation PriceListUpdate($id: ID!, $input: PriceListUpdateInput!) { priceListUpdate(id: $id, input: $input) { priceList { id } userErrors { field message code } } }`,
      { id: priceListId, input: { currency: pl.currency, parent: priceListParent(pl) } },
    );
    assertNoUserErrors(res.priceListUpdate, `priceListUpdate ${title}`);
  }
  const prices = d.fixedPrices as FixedPrice[] | undefined;
  if (pl && priceListId && prices?.length) await addFixedPrices(client, priceListId, pl.currency, prices);

  const pub = d.publication as { autoPublish: boolean } | undefined;
  if (pub && !existing.publication) {
    const res = await client.request(
      `mutation PublicationCreate($input: PublicationCreateInput!) { publicationCreate(input: $input) { publication { id } userErrors { field message code } } }`,
      { input: { catalogId, autoPublish: pub.autoPublish, defaultState: "EMPTY" } },
    );
    assertNoUserErrors(res.publicationCreate, `publicationCreate ${title}`);
  } else if (pub && existing.publication) {
    const res = await client.request(
      `mutation PublicationUpdate($id: ID!, $input: PublicationUpdateInput!) { publicationUpdate(id: $id, input: $input) { publication { id } userErrors { field message code } } }`,
      { id: existing.publication, input: { autoPublish: pub.autoPublish } },
    );
    assertNoUserErrors(res.publicationUpdate, `publicationUpdate ${title}`);
  }
}

export const catalogs: ResourceAdapter = {
  kind: "catalogs",
  description:
    "Market catalogs, keyed by title: status, markets, and price list (currency, percentage adjustment, compare-at mode); with prices on, fixed variant prices too. Product inclusion is synced by sales_channels; a new catalog starts empty. Markets and fixed prices only the target has are kept. Opt-in.",

  async fetch(client, opts) {
    const nodes = await paginate<Node>(client, QUERY, {}, (d) => d.catalogs);
    const items: Item[] = [];
    for (const n of nodes) {
      const pl = n.priceList;
      items.push({
        key: n.title,
        id: n.id,
        data: compact({
          status: n.status,
          markets: (n.markets?.nodes ?? []).map((m) => marketRef(m.handle)).sort(),
          priceList: pl?.parent ? { currency: pl.currency, adjustment: pl.parent.adjustment, compareAtMode: pl.parent.settings.compareAtMode } : pl ? { currency: pl.currency, adjustment: { type: "PERCENTAGE_DECREASE", value: 0 }, compareAtMode: "ADJUSTED" } : undefined,
          fixedPrices: opts.prices && pl?.fixedPricesCount ? await fixedPrices(client, pl.id) : undefined,
          publication: n.publication ? { autoPublish: n.publication.autoPublish } : undefined,
        }),
      });
    }
    return { items, skipped: [] };
  },

  refFor: (key) => `shopify://Catalog/${key}`,

  canonical(d) {
    const prices = d.fixedPrices as FixedPrice[] | undefined;
    return prices
      ? { ...d, fixedPrices: [...prices].map((p) => compact({ ...p, price: amount(p.price)!, compareAtPrice: amount(p.compareAtPrice) }) as FixedPrice).sort((a, b) => a.variant.localeCompare(b.variant)) }
      : d;
  },

  /** Markets and fixed prices only the target has are kept, so they aren't differences. */
  alignTarget(source, target) {
    const markets = new Set((source.markets as string[]) ?? []);
    const out: Record<string, unknown> = { ...target, markets: ((target.markets as string[]) ?? []).filter((m) => markets.has(m)) };
    if (target.fixedPrices) {
      const wanted = new Set(((source.fixedPrices as FixedPrice[]) ?? []).map((p) => p.variant));
      out.fixedPrices = (target.fixedPrices as FixedPrice[]).filter((p) => wanted.has(p.variant));
    }
    return out;
  },

  async create({ client }, key, d) {
    await checkCurrency(client, key, d);
    const res = await client.request(
      `mutation CatalogCreate($input: CatalogCreateInput!) { catalogCreate(input: $input) { catalog { id } userErrors { field message code } } }`,
      { input: { title: key, status: d.status, context: { marketIds: (d.markets as string[]) ?? [] } } },
    );
    assertNoUserErrors(res.catalogCreate, `catalogCreate ${key}`);
    const id = res.catalogCreate.catalog.id as string;
    await writeParts(client, id, key, d, {});
    return id;
  },

  async update({ client, resolver }, target, d) {
    await checkCurrency(client, target.key, d);
    // Markets the target catalog already has stay on it: the context sent is the union.
    const kept = await Promise.all(((target.data.markets as string[]) ?? []).map((r) => resolver.resolve(r)));
    const marketIds = [...new Set([...((d.markets as string[]) ?? []), ...kept.filter((x): x is string => Boolean(x))])];
    const res = await client.request(
      `mutation CatalogUpdate($id: ID!, $input: CatalogUpdateInput!) { catalogUpdate(id: $id, input: $input) { catalog { id } userErrors { field message code } } }`,
      { id: target.id, input: { status: d.status, context: { marketIds } } },
    );
    assertNoUserErrors(res.catalogUpdate, `catalogUpdate ${target.key}`);
    const parts = (await client.request(CATALOG_PARTS, { id: target.id })).catalog;
    await writeParts(client, target.id, target.key, d, { priceList: parts?.priceList?.id, publication: parts?.publication?.id });
  },
};
