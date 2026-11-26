import type { Snapshot } from "./snapshot.js";
import type { AdminClient } from "./shopify/client.js";

/*
 * Stores that sell in different currencies. Amounts are never converted on a guess: prices move
 * between currencies only with a rate the person gives (currency_rates: { "MAD:EUR": 0.092 }, or the
 * reverse rate). Without one, prices are left out of the comparison and the plan says why.
 */

export type Rates = Record<string, number>;

export interface ShopCurrencies {
  currency: string;
  /** Every currency the store sells in, its own included. */
  enabled: string[];
}

export async function shopCurrencies(client: AdminClient): Promise<ShopCurrencies> {
  const { shop } = await client.request<{ shop: { currencyCode: string; enabledPresentmentCurrencies: string[] } }>(
    `query ShopCurrencies { shop { currencyCode enabledPresentmentCurrencies } }`,
  );
  return { currency: shop.currencyCode, enabled: [...new Set([shop.currencyCode, ...shop.enabledPresentmentCurrencies])] };
}

/** The rate from one currency to another: given as "FROM:TO", or as the reverse "TO:FROM". */
export function rateFor(rates: Rates | undefined, from: string, to: string): number | undefined {
  if (from === to) return 1;
  const direct = rates?.[`${from}:${to}`];
  if (direct && direct > 0) return direct;
  const reverse = rates?.[`${to}:${from}`];
  return reverse && reverse > 0 ? 1 / reverse : undefined;
}

/** How many decimals a currency is priced in (2 for EUR, 0 for JPY). */
export function decimals(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function convertAmount(amount: string | undefined, rate: number, to: string): string | undefined {
  if (amount === undefined || amount === null || amount === "") return amount;
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  return (n * rate).toFixed(decimals(to));
}

/** "MAD:EUR=0.092,USD:EUR=0.86" from the command line. */
export function parseRates(spec: string): Rates {
  const out: Rates = {};
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^([A-Z]{3}):([A-Z]{3})=([0-9]*\.?[0-9]+)$/i.exec(part);
    if (!m || !(Number(m[3]) > 0)) throw new Error(`--currency-rate takes FROM:TO=rate, like MAD:EUR=0.092, not "${part}"`);
    out[`${m[1]!.toUpperCase()}:${m[2]!.toUpperCase()}`] = Number(m[3]);
  }
  return out;
}

const ratesHint = (from: string, to: string) => `pass currency_rates {"${from}:${to}": <rate>} (--currency-rate ${from}:${to}=<rate>) to convert`;

/**
 * Bring the source's amounts into the target's currencies before comparing, or leave them out.
 * Changes `a` (and, for prices left out, `b`) in place; returns what the plan should say.
 */
export function adjustCurrencies(a: Snapshot, b: Snapshot, src: ShopCurrencies, tgt: ShopCurrencies, rates: Rates | undefined, prices: boolean): string[] {
  const notes: string[] = [];

  const products = a.resources.products?.items ?? [];
  if (prices && products.length && src.currency !== tgt.currency) {
    const rate = rateFor(rates, src.currency, tgt.currency);
    const variantsOf = (d: Record<string, unknown>) => (d.variants as Record<string, unknown>[] | undefined) ?? [];
    if (rate) {
      for (const p of products) {
        p.data = { ...p.data, variants: variantsOf(p.data).map((v) => ({ ...v, price: convertAmount(v.price as string, rate, tgt.currency), compareAtPrice: convertAmount(v.compareAtPrice as string, rate, tgt.currency) })) };
      }
      notes.push(`Product prices converted from ${src.currency} to ${tgt.currency} at ${rate}, rounded to ${decimals(tgt.currency)} decimals.`);
    } else {
      for (const p of [...products, ...(b.resources.products?.items ?? [])]) {
        p.data = { ...p.data, variants: variantsOf(p.data).map(({ price: _p, compareAtPrice: _c, ...v }) => v) };
      }
      notes.push(`Product prices left out: ${a.store} sells in ${src.currency}, ${b.store} in ${tgt.currency}; ${ratesHint(src.currency, tgt.currency)}.`);
    }
  }

  for (const c of a.resources.catalogs?.items ?? []) {
    const pl = c.data.priceList as { currency: string } | undefined;
    if (!pl || tgt.enabled.includes(pl.currency)) continue;
    const fixed = c.data.fixedPrices as { variant: string; price: string; compareAtPrice?: string }[] | undefined;
    const to = [tgt.currency, ...tgt.enabled].find((x) => rateFor(rates, pl.currency, x));
    if (to) {
      const rate = rateFor(rates, pl.currency, to)!;
      c.data = {
        ...c.data,
        priceList: { ...pl, currency: to },
        ...(fixed ? { fixedPrices: fixed.map((f) => ({ ...f, price: convertAmount(f.price, rate, to)!, compareAtPrice: convertAmount(f.compareAtPrice, rate, to) })) } : {}),
      };
      notes.push(`Catalog ${c.key}: price list moved from ${pl.currency} to ${to}${fixed?.length ? `, fixed prices converted at ${rate}` : ""}.`);
    } else if (!fixed?.length) {
      // A percentage price list has no amounts: it can follow the target's own currency.
      c.data = { ...c.data, priceList: { ...pl, currency: tgt.currency } };
      notes.push(`Catalog ${c.key}: ${b.store} doesn't sell in ${pl.currency}, so its price list (a percentage, no fixed prices) is set in ${tgt.currency}.`);
    } else {
      notes.push(`Catalog ${c.key}: its fixed prices are in ${pl.currency}, which ${b.store} doesn't sell in (${tgt.enabled.join(", ")}); enable ${pl.currency} there, or ${ratesHint(pl.currency, tgt.currency)}. It will be refused until then.`);
    }
  }

  const targetMarkets = new Map((b.resources.markets?.items ?? []).map((m) => [m.key, m]));
  for (const m of a.resources.markets?.items ?? []) {
    const cur = m.data.currency as { baseCurrency: string } | undefined;
    if (!cur || tgt.enabled.includes(cur.baseCurrency)) continue;
    const to = [tgt.currency, ...tgt.enabled].find((x) => rateFor(rates, cur.baseCurrency, x));
    const theirs = targetMarkets.get(m.key)?.data.currency;
    if (to) {
      m.data = { ...m.data, currency: { ...cur, baseCurrency: to } };
      notes.push(`Market ${m.key}: sells in ${to} in ${b.store}, which doesn't sell in ${cur.baseCurrency}.`);
    } else {
      const { currency: _c, ...rest } = m.data;
      m.data = theirs ? { ...rest, currency: theirs } : rest;
      notes.push(`Market ${m.key}: its currency ${cur.baseCurrency} isn't sold in ${b.store} (${tgt.enabled.join(", ")}), so ${theirs ? "the target's currency setting is kept" : "it uses the target's default currency"}; enable ${cur.baseCurrency} there, or ${ratesHint(cur.baseCurrency, tgt.currency)}.`);
    }
  }
  return notes;
}
