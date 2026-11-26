import { applyPlan, type ApplyOptions, type OpResult } from "./apply.js";
import type { StoreConfig, StoreRegistry } from "./config.js";
import { diffItems, type FieldChange, type KeyFilter, type ResourceDiff } from "./diff.js";
import { buildPlan, PlanStore, type Plan } from "./plan.js";
import { collectRefs, REF_PREFIX, RefToGidResolver, UNRESOLVED_PREFIX } from "./refs.js";
import { DEFAULT_KINDS, type FetchOptions, type ResourceKind } from "./resources/index.js";
import { listProducts } from "./resources/products.js";
import { publicationsByLabel } from "./resources/salesChannels.js";
import { applyTypeMismatch, type TypeMismatch } from "./typeMismatch.js";
import { adjustCurrencies, shopCurrencies, type Rates } from "./currency.js";
import { ShopifyAdminClient, type AdminClient } from "./shopify/client.js";
import { ShopifyCliClient } from "./shopify/cliClient.js";
import { applyView, takeSnapshot, type ReadProgress, type Snapshot } from "./snapshot.js";
import { exportSnapshot, readSnapshot, type ExportResult } from "./snapshotFiles.js";
import { keySet, metafieldOwnersOf, ownerTypesOf, productHandlesOf } from "./narrow.js";
import { diffThemes, type ThemeDiff, type ThemeDiffOptions } from "./themes.js";

/** One place for everything the MCP tools and the CLI do, so both behave the same. */

export interface Scope {
  resources?: ResourceKind[];
  ownerTypes?: string[];
  metaobjectTypes?: string[];
  namespaces?: string[];
  locales?: string[];
  /** Copy the products picked by hand into manual collections (collections). */
  collectionProducts?: boolean;
  /** Also read and copy the translations each market overrides (translations). */
  marketTranslations?: boolean;
  /** Copy variant prices too (products), and fixed prices of price lists (catalogs). */
  prices?: boolean;
  /** Copy stock too: available quantity per location, matched by location name (products). */
  inventory?: boolean;
  /** Leave the published state alone: new pages arrive hidden, new metaobject entries as drafts. */
  drafts?: boolean;
  include?: string[];
  exclude?: string[];
  /** Exchange rates for stores that sell in different currencies, "FROM:TO" -> rate (the reverse works too). */
  currencyRates?: Rates;
  /** When a metafield's type differs between the stores: convert the values, or retype the target's definition. Default: report a conflict. */
  typeMismatch?: TypeMismatch;
  /** Compare Shopify-reserved metafield definitions too (read-only). */
  includeReserved?: boolean;
}

export interface ItemCheck {
  kind: ResourceKind;
  key: string;
  source: string;
  target: string;
  status: "identical" | "different" | "only in source" | "only in target" | "in neither";
  changes: FieldChange[];
  sourceData?: Record<string, unknown>;
  targetData?: Record<string, unknown>;
  /** Items the checked item points at (as "Product/linen-shirt" etc.), and whether the target has them. */
  refs: { ref: string; inTarget: boolean | string }[];
  notCompared: { kind: string; key: string; reason: string }[];
}

export const DIR_PREFIX = "dir:";

export function isDirSpec(spec: string): boolean {
  return spec.startsWith(DIR_PREFIX);
}

/** What a long run is doing, for a progress display. All optional. */
export interface EngineEvents {
  /** A request was sent to a store. */
  request?: (store: string) => void;
  /** A resource type was read from a store. */
  read?: (store: string, kind: ResourceKind, items: number) => void;
  /** The run moved to its next phase. */
  phase?: (message: string) => void;
  /** A write step finished. */
  step?: (done: number, total: number, message: string) => void;
  /** Inside a Shopify bulk write: about how many items are written so far. */
  bulk?: (kind: ResourceKind, written: number, total: number) => void;
}

export class Engine {
  private readonly clients = new Map<string, AdminClient>();
  /** Progress listeners (the command line sets them; the MCP server reports through its own). */
  events: EngineEvents = {};

  constructor(
    readonly registry: StoreRegistry,
    readonly plans: PlanStore = new PlanStore(),
    private readonly clientFactory: (store: StoreConfig) => AdminClient = (s) => (s.auth === "shopify-cli" ? new ShopifyCliClient(s) : new ShopifyAdminClient(s)),
  ) {}

  client(alias: string): AdminClient {
    let c = this.clients.get(alias);
    if (!c) {
      const inner = this.clientFactory(this.registry.get(alias));
      // Every request is counted for the progress display; the client itself is untouched.
      c = {
        store: inner.store,
        request: <T>(query: string, variables?: Record<string, unknown>) => {
          this.events.request?.(alias);
          return inner.request<T>(query, variables);
        },
      };
      this.clients.set(alias, c);
    }
    return c;
  }

  static kinds(scope: Scope): ResourceKind[] {
    return scope.resources?.length ? scope.resources : [...DEFAULT_KINDS];
  }

  static fetchOptions(scope: Scope): FetchOptions {
    return {
      ownerTypes: scope.ownerTypes ?? Engine.ownerTypes(scope.include),
      includeReserved: scope.includeReserved || undefined,
      metaobjectTypes: scope.metaobjectTypes,
      namespaces: scope.namespaces,
      locales: scope.locales,
      marketTranslations: scope.marketTranslations || undefined,
      collectionProducts: scope.collectionProducts || undefined,
      prices: scope.prices,
      inventory: scope.inventory || undefined,
      drafts: scope.drafts || undefined,
      productHandles: Engine.productHandles(scope.include),
      metafieldOwners: Engine.metafieldOwners(scope.include),
      keys: keySet(scope.include),
    };
  }

  static ownerTypes = ownerTypesOf;
  static metafieldOwners = metafieldOwnersOf;
  static productHandles = productHandlesOf;

  /** Languages present in a snapshot's translations. */
  static locales(snapshot: Snapshot): string[] {
    return [...new Set((snapshot.resources.translations?.items ?? []).map((i) => String(i.data.locale)))].sort();
  }

  static filter(scope: Scope): KeyFilter {
    return { include: scope.include, exclude: scope.exclude };
  }

  /** A store alias, or "dir:<path>" for a snapshot folder. */
  async load(spec: string, scope: Scope, onRead?: ReadProgress, extra: Partial<FetchOptions> = {}): Promise<Snapshot> {
    const kinds = Engine.kinds(scope);
    const opts = { ...Engine.fetchOptions(scope), ...extra };
    if (isDirSpec(spec)) {
      const snapshot = readSnapshot(spec.slice(DIR_PREFIX.length), kinds);
      // A folder holds whatever was exported; it is looked at the same way a store would be.
      for (const kind of kinds) {
        const res = snapshot.resources[kind];
        if (res) res.items = res.items.map((i) => ({ ...i, data: applyView(kind, i.data, opts) }));
      }
      return snapshot;
    }
    return takeSnapshot(this.client(spec), kinds, opts, this.reading(onRead));
  }

  /** The caller's read callback, plus the progress listener. */
  private reading(onRead?: ReadProgress): ReadProgress {
    return (store, kind, items) => {
      onRead?.(store, kind, items);
      this.events.read?.(store, kind, items);
    };
  }

  async snapshot(spec: string, scope: Scope): Promise<{ snapshot: Snapshot; diffs: ResourceDiff[] }> {
    const snapshot = await this.load(spec, scope);
    const diffs = Engine.kinds(scope).map((k) => diffItems(k, snapshot.resources[k]?.items ?? [], [], Engine.filter(scope)));
    return { snapshot, diffs };
  }

  private emptySnapshot(spec: string): Snapshot {
    const store = isDirSpec(spec) ? undefined : this.registry.get(spec);
    return { store: store?.alias ?? spec, domain: store?.domain ?? spec, takenAt: new Date().toISOString(), resources: {}, files: {} };
  }

  async compare(source: string, target: string, scope: Scope, onRead?: ReadProgress) {
    if (source === target) throw new Error("source and target must be different");
    const kinds = Engine.kinds(scope);
    // Read both stores at once. The target's translations are read afterwards, in the
    // source's languages, so both sides are comparable.
    const laterTranslations = kinds.includes("translations") && !scope.locales?.length;
    const firstKinds = laterTranslations ? kinds.filter((k) => k !== "translations") : kinds;
    const targetExtra = await this.narrowTargetProducts(source, target, scope, firstKinds);
    const [a, b] = await Promise.all([
      this.load(source, scope, onRead),
      firstKinds.length ? this.load(target, { ...scope, resources: firstKinds }, onRead, targetExtra) : Promise.resolve(this.emptySnapshot(target)),
    ]);
    if (laterTranslations) {
      const t = await this.load(target, { ...scope, resources: ["translations"], locales: Engine.locales(a) }, onRead);
      b.resources.translations = t.resources.translations;
      Object.assign(b.files, t.files);
    }
    // Something one side couldn't read (a "PRODUCT.*" style key) is left out on both sides:
    // otherwise everything the target has there would look missing and be planned as new.
    const unreadable = (k: ResourceKind) => [a, b].flatMap((s) => (s.resources[k]?.skipped ?? []).filter((x) => x.key.endsWith("*")).map((x) => x.key));
    // Stores that sell in different currencies: amounts converted with the person's rates, or left out.
    let currencyNotes: string[] = [];
    if (!isDirSpec(source) && !isDirSpec(target) && ((scope.prices && kinds.includes("products")) || kinds.includes("catalogs") || kinds.includes("markets"))) {
      const [sc, tc] = await Promise.all([shopCurrencies(this.client(source)), shopCurrencies(this.client(target))]);
      currencyNotes = adjustCurrencies(a, b, sc, tc, scope.currencyRates, Boolean(scope.prices));
    }
    const diffs = kinds.map((k) => {
      const filter = Engine.filter(scope);
      const out = unreadable(k);
      return diffItems(k, a.resources[k]?.items ?? [], b.resources[k]?.items ?? [], out.length ? { ...filter, exclude: [...(filter.exclude ?? []), ...out] } : filter);
    });
    const skipped = kinds.flatMap((k) => [
      ...(a.resources[k]?.skipped ?? []).map((x) => ({ kind: k, ...x, key: x.key.endsWith("*") ? `${x.key} (in ${a.store})` : x.key })),
      ...(b.resources[k]?.skipped ?? []).filter((x) => x.key.endsWith("*")).map((x) => ({ kind: k, ...x, key: `${x.key} (in ${b.store})` })),
    ]);
    return { source: a, target: b, diffs, skipped, currencyNotes };
  }

  /**
   * Products are read in full only where they can be compared: the target's products whose handle
   * the source also has. The rest of the target is listed by handle (cheap), so it still shows as
   * "only in target". Without this, a small store compared with a big one reads the big one whole.
   */
  private async narrowTargetProducts(source: string, target: string, scope: Scope, kinds: ResourceKind[]): Promise<Partial<FetchOptions>> {
    if (!kinds.includes("products") || isDirSpec(source) || isDirSpec(target) || Engine.productHandles(scope.include)) return {};
    this.events.phase?.("listing products in both stores");
    const [src, tgt] = await Promise.all([listProducts(this.client(source)), listProducts(this.client(target))]);
    const inSource = new Set(src.map((p) => p.handle));
    const both = tgt.filter((p) => inSource.has(p.handle) && !p.isGiftCard).map((p) => p.handle);
    // Reading by handle only pays off when it skips a good part of the target.
    if (both.length > tgt.length / 2) return {};
    const stubs = tgt.filter((p) => !inSource.has(p.handle) && !p.isGiftCard).map(({ id, handle, title }) => ({ id, handle, title }));
    return { productHandles: { exact: both, prefixes: [] }, productStubs: stubs };
  }

  /**
   * One item, side by side: whether each store has it, which fields differ, and whether the items
   * it points at exist in the target. Reads only that item where the resource type allows it.
   */
  async check(source: string, target: string, kind: ResourceKind, key: string, scope: Omit<Scope, "resources" | "include"> = {}): Promise<ItemCheck> {
    const { source: a, target: b, diffs, skipped } = await this.compare(source, target, { ...scope, resources: [kind], include: [key] });
    const s = a.resources[kind]?.items.find((i) => i.key === key);
    const t = b.resources[kind]?.items.find((i) => i.key === key);
    const changes = diffs[0]?.changed.find((c) => c.key === key)?.changes ?? [];
    const status: ItemCheck["status"] = !s && !t ? "in neither" : !t ? "only in source" : !s ? "only in target" : changes.length ? "different" : "identical";

    // What the source item points at, and whether each exists in the target.
    const refs: ItemCheck["refs"] = [];
    const from = s ?? t;
    if (from && !isDirSpec(target)) {
      const resolver = new RefToGidResolver(this.client(target));
      const all = [...collectRefs(from.data)].sort();
      const found = await Promise.all(all.map((r) => (r.startsWith(UNRESOLVED_PREFIX) ? Promise.resolve(undefined) : resolver.resolve(r))));
      all.forEach((ref, i) =>
        refs.push({ ref: ref.slice(REF_PREFIX.length), inTarget: ref.startsWith(UNRESOLVED_PREFIX) ? "can't be matched across stores" : Boolean(found[i]) }),
      );
    }
    return {
      kind,
      key,
      source: a.store,
      target: b.store,
      status,
      changes,
      sourceData: s?.data,
      targetData: t?.data,
      refs,
      notCompared: skipped.filter((x) => x.key.includes("*")),
    };
  }

  async plan(source: string, target: string, scope: Scope, onRead?: ReadProgress): Promise<Plan> {
    if (isDirSpec(target)) throw new Error("the target of a sync must be a store, not a snapshot folder");
    const { source: a, diffs, skipped, currencyNotes } = await this.compare(source, target, scope, onRead);
    const t = this.client(target);
    this.events.phase?.(`checking what ${t.store.alias} already has that the changes point at`);
    const plan = await buildPlan({
      source: { alias: a.store, domain: a.domain },
      target: { alias: t.store.alias, domain: t.store.domain },
      diffs,
      skipped,
      files: a.files,
      resolver: new RefToGidResolver(t),
      fetchOptions: Engine.fetchOptions(scope),
    });
    plan.warnings.push(...currencyNotes);
    if (scope.typeMismatch) await applyTypeMismatch(plan, scope.typeMismatch, t);
    const newProducts = plan.ops.filter((o) => o.kind === "products" && o.action === "create").length;
    if (newProducts) plan.warnings.push(`${newProducts} new product(s) will be created as drafts; publish them in ${t.store.alias} when they're ready.`);
    if (plan.ops.some((o) => o.kind === "products" && o.action !== "conflict") && !scope.prices) {
      plan.warnings.push("Prices are not copied (new variants start at 0.00 in the draft). Pass prices: true (--with-prices) to copy them.");
    }
    const creates = (kind: string, visible: (d: Record<string, unknown>) => boolean) =>
      plan.ops.filter((o) => o.kind === kind && o.action === "create" && visible(o.data)).length;
    if (scope.drafts) {
      if (plan.ops.some((o) => (o.kind === "pages" || o.kind === "metaobjects") && o.action === "create")) {
        plan.warnings.push(`New pages will be created hidden and new metaobject entries as drafts; publish them in ${t.store.alias} when they're ready.`);
      }
    } else {
      const pages = creates("pages", (d) => d.isPublished === true);
      const entries = creates("metaobjects", (d) => d.status === "ACTIVE");
      const live = [pages ? `${pages} new page(s)` : "", entries ? `${entries} new metaobject entr${entries === 1 ? "y" : "ies"}` : ""].filter(Boolean);
      if (live.length) {
        plan.warnings.push(
          `${live.join(" and ")} will be visible in ${t.store.alias} as soon as created, because they are published in the source. Pass as_drafts: true (--as-drafts) to create them hidden instead.`,
        );
      }
    }
    const newCollections = plan.ops.filter((o) => o.kind === "collections" && o.action === "create").length;
    if (newCollections && !plan.kinds.includes("sales_channels")) {
      plan.warnings.push(`${newCollections} new collection(s) will not be published to any sales channel; publish them in ${t.store.alias} when they're ready, or include sales_channels.`);
    }
    const newCatalogs = plan.ops.filter((o) => o.kind === "catalogs" && o.action === "create" && o.data.publication).map((o) => o.key);
    if (newCatalogs.length && !plan.kinds.includes("sales_channels")) {
      plan.warnings.push(
        `New catalog(s) ${newCatalogs.join(", ")} will start with no products, so their markets won't sell anything until products are added; include sales_channels to copy which products they include.`,
      );
    }
    const publishing = plan.ops.filter((o) => o.kind === "sales_channels" && o.action !== "conflict");
    if (publishing.length) {
      const have = await publicationsByLabel(t);
      const created = new Set(plan.ops.filter((o) => o.kind === "catalogs" && o.action === "create" && o.data.publication).map((o) => `catalog:${o.key}`));
      const missing = new Map<string, number>();
      for (const o of publishing) {
        for (const c of (o.data.channels as string[]) ?? []) if (!have.has(c) && !created.has(c)) missing.set(c, (missing.get(c) ?? 0) + 1);
      }
      for (const [c, n] of missing) {
        plan.warnings.push(
          `${n} item(s) are on ${c}, which ${t.store.alias} doesn't have (${c.startsWith("catalog:") ? "sync that catalog too" : "install that sales channel there"}); they will be published on their other channels and reported as failed.`,
        );
      }
    }
    if (plan.ops.some((o) => o.kind === "translations")) {
      const enabled = new Set(
        (await t.request<{ shopLocales: { locale: string }[] }>(`query { shopLocales { locale } }`)).shopLocales.map((l) => l.locale),
      );
      const missing = Engine.locales(a).filter((l) => !enabled.has(l));
      if (missing.length) {
        plan.warnings.push(
          `Language(s) ${missing.join(", ")} are not added to ${t.store.alias}; add them in Settings > Languages first or those translations will fail.`,
        );
      }
    }
    const notSaved = this.plans.save(plan);
    if (notSaved) {
      plan.warnings.push(
        `This plan could not be saved to disk (${notSaved}), so it lasts only while this process runs. Narrow the scope (resources, include) to make it smaller.`,
      );
    }
    return plan;
  }

  async apply(planId: string, opts: ApplyOptions = {}): Promise<{ plan: Plan; results: OpResult[] }> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`no plan with id ${planId}`);
    const results = await applyPlan(plan, this.client(plan.target.alias), {
      ...opts,
      onPhase: (m) => {
        opts.onPhase?.(m);
        this.events.phase?.(m);
      },
      onProgress: (done, total, m) => {
        opts.onProgress?.(done, total, m);
        this.events.step?.(done, total, m);
      },
      onBulkProgress: (kind, written, total) => {
        opts.onBulkProgress?.(kind, written, total);
        this.events.bulk?.(kind, written, total);
      },
    });
    this.plans.save(plan);
    return { plan, results };
  }

  async export(store: string, dir: string, scope: Scope, onRead?: ReadProgress): Promise<ExportResult> {
    if (isDirSpec(store)) throw new Error("export reads from a store; give a store alias");
    const snapshot = await takeSnapshot(this.client(store), Engine.kinds(scope), Engine.fetchOptions(scope), this.reading(onRead));
    return exportSnapshot(snapshot, dir);
  }

  async themes(source: string, target: string, opts: ThemeDiffOptions): Promise<ThemeDiff> {
    if (isDirSpec(source) || isDirSpec(target)) throw new Error("theme comparison needs two stores");
    return diffThemes(this.client(source), this.client(target), opts);
  }
}
