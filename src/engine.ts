import { applyPlan, type ApplyOptions, type OpResult } from "./apply.js";
import type { StoreConfig, StoreRegistry } from "./config.js";
import { diffItems, type KeyFilter, type ResourceDiff } from "./diff.js";
import { buildPlan, PlanStore, type Plan } from "./plan.js";
import { RefToGidResolver } from "./refs.js";
import { DEFAULT_KINDS, type FetchOptions, type ResourceKind } from "./resources/index.js";
import { ShopifyAdminClient, type AdminClient } from "./shopify/client.js";
import { ShopifyCliClient } from "./shopify/cliClient.js";
import { takeSnapshot, type Snapshot } from "./snapshot.js";
import { exportSnapshot, readSnapshot, type ExportResult } from "./snapshotFiles.js";
import { diffThemes, type ThemeDiff } from "./themes.js";

/** One place for everything the MCP tools and the CLI do, so both behave the same. */

export interface Scope {
  resources?: ResourceKind[];
  ownerTypes?: string[];
  metaobjectTypes?: string[];
  namespaces?: string[];
  locales?: string[];
  /** Copy variant prices too (products). */
  prices?: boolean;
  include?: string[];
  exclude?: string[];
}

export const DIR_PREFIX = "dir:";

export function isDirSpec(spec: string): boolean {
  return spec.startsWith(DIR_PREFIX);
}

export class Engine {
  private readonly clients = new Map<string, AdminClient>();

  constructor(
    readonly registry: StoreRegistry,
    readonly plans: PlanStore = new PlanStore(),
    private readonly clientFactory: (store: StoreConfig) => AdminClient = (s) => (s.auth === "shopify-cli" ? new ShopifyCliClient(s) : new ShopifyAdminClient(s)),
  ) {}

  client(alias: string): AdminClient {
    let c = this.clients.get(alias);
    if (!c) {
      c = this.clientFactory(this.registry.get(alias));
      this.clients.set(alias, c);
    }
    return c;
  }

  static kinds(scope: Scope): ResourceKind[] {
    return scope.resources?.length ? scope.resources : [...DEFAULT_KINDS];
  }

  static fetchOptions(scope: Scope): FetchOptions {
    return { ownerTypes: scope.ownerTypes, metaobjectTypes: scope.metaobjectTypes, namespaces: scope.namespaces, locales: scope.locales, prices: scope.prices };
  }

  /** Languages present in a snapshot's translations. */
  static locales(snapshot: Snapshot): string[] {
    return [...new Set((snapshot.resources.translations?.items ?? []).map((i) => String(i.data.locale)))].sort();
  }

  static filter(scope: Scope): KeyFilter {
    return { include: scope.include, exclude: scope.exclude };
  }

  /** A store alias, or "dir:<path>" for a snapshot folder. */
  async load(spec: string, scope: Scope): Promise<Snapshot> {
    const kinds = Engine.kinds(scope);
    if (isDirSpec(spec)) return readSnapshot(spec.slice(DIR_PREFIX.length), kinds);
    return takeSnapshot(this.client(spec), kinds, Engine.fetchOptions(scope));
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

  async compare(source: string, target: string, scope: Scope) {
    if (source === target) throw new Error("source and target must be different");
    const kinds = Engine.kinds(scope);
    // Read both stores at once. The target's translations are read afterwards, in the
    // source's languages, so both sides are comparable.
    const laterTranslations = kinds.includes("translations") && !scope.locales?.length;
    const firstKinds = laterTranslations ? kinds.filter((k) => k !== "translations") : kinds;
    const [a, b] = await Promise.all([
      this.load(source, scope),
      firstKinds.length ? this.load(target, { ...scope, resources: firstKinds }) : Promise.resolve(this.emptySnapshot(target)),
    ]);
    if (laterTranslations) {
      const t = await this.load(target, { ...scope, resources: ["translations"], locales: Engine.locales(a) });
      b.resources.translations = t.resources.translations;
      Object.assign(b.files, t.files);
    }
    const diffs = kinds.map((k) => diffItems(k, a.resources[k]?.items ?? [], b.resources[k]?.items ?? [], Engine.filter(scope)));
    const skipped = kinds.flatMap((k) => (a.resources[k]?.skipped ?? []).map((x) => ({ kind: k, ...x })));
    return { source: a, target: b, diffs, skipped };
  }

  async plan(source: string, target: string, scope: Scope): Promise<Plan> {
    if (isDirSpec(target)) throw new Error("the target of a sync must be a store, not a snapshot folder");
    const { source: a, diffs, skipped } = await this.compare(source, target, scope);
    const t = this.client(target);
    const plan = await buildPlan({
      source: { alias: a.store, domain: a.domain },
      target: { alias: t.store.alias, domain: t.store.domain },
      diffs,
      skipped,
      files: a.files,
      resolver: new RefToGidResolver(t),
      fetchOptions: Engine.fetchOptions(scope),
    });
    const newProducts = plan.ops.filter((o) => o.kind === "products" && o.action === "create").length;
    if (newProducts) plan.warnings.push(`${newProducts} new product(s) will be created as drafts; publish them in ${t.store.alias} when they're ready.`);
    if (plan.ops.some((o) => o.kind === "products" && o.action !== "conflict") && !scope.prices) {
      plan.warnings.push("Prices are not copied (new variants start at 0.00 in the draft). Pass prices: true (--with-prices) to copy them.");
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
    this.plans.save(plan);
    return plan;
  }

  async apply(planId: string, opts: ApplyOptions = {}): Promise<{ plan: Plan; results: OpResult[] }> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(`no plan with id ${planId}`);
    const results = await applyPlan(plan, this.client(plan.target.alias), opts);
    this.plans.save(plan);
    return { plan, results };
  }

  async export(store: string, dir: string, scope: Scope): Promise<ExportResult> {
    if (isDirSpec(store)) throw new Error("export reads from a store; give a store alias");
    const snapshot = await takeSnapshot(this.client(store), Engine.kinds(scope), Engine.fetchOptions(scope));
    return exportSnapshot(snapshot, dir);
  }

  async themes(source: string, target: string, opts: { sourceTheme?: string; targetTheme?: string; files?: string[]; exclude?: string[] }): Promise<ThemeDiff> {
    if (isDirSpec(source) || isDirSpec(target)) throw new Error("theme comparison needs two stores");
    return diffThemes(this.client(source), this.client(target), opts);
  }
}
