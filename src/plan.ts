import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hashData, type FieldChange, type ResourceDiff } from "./diff.js";
import { collectRefs, REF_PREFIX, UNRESOLVED_PREFIX, type FileSource, type RefToGidResolver } from "./refs.js";
import { ADAPTERS, orderKinds, type FetchOptions, type ResourceKind } from "./resources/index.js";

export type OpAction = "create" | "update" | "conflict";

export interface PlanOp {
  seq: number;
  kind: ResourceKind;
  key: string;
  action: OpAction;
  /** Desired state, in portable form (refs, not GIDs). */
  data: Record<string, unknown>;
  /** Target GID for updates. */
  targetId?: string;
  /** Hash of the target's data at plan time, to detect drift before applying. */
  targetHash?: string;
  /** Snapshot of the target's data at plan time (needed by adapters that diff fields on update). */
  targetData?: Record<string, unknown>;
  changes?: FieldChange[];
  reason?: string;
  /** Refs that don't exist in the target and won't be created by this plan. */
  missingRefs?: string[];
}

export interface Plan {
  id: string;
  createdAt: string;
  expiresAt: string;
  source: { alias: string; domain: string };
  target: { alias: string; domain: string };
  kinds: ResourceKind[];
  ops: PlanOp[];
  /** Present in target but not in source. Reported only: this tool never deletes. */
  onlyInTarget: { kind: ResourceKind; keys: string[] }[];
  skipped: { kind: ResourceKind; key: string; reason: string }[];
  warnings: string[];
  /** Source download URLs for files the plan may need to upload to the target. */
  files: Record<string, FileSource>;
  /** Read options the plan was made with, so the drift check before applying reads the target the same way. */
  fetchOptions?: FetchOptions;
  status: "pending" | "applied" | "partially_applied" | "failed";
}

export const PLAN_TTL_MS = 60 * 60 * 1000;

export interface BuildPlanInput {
  source: { alias: string; domain: string };
  target: { alias: string; domain: string };
  diffs: ResourceDiff[];
  skipped?: Plan["skipped"];
  resolver: RefToGidResolver;
  /** File sources from the source snapshot. */
  files?: Record<string, FileSource>;
  fetchOptions?: FetchOptions;
  now?: Date;
}

export async function buildPlan(input: BuildPlanInput): Promise<Plan> {
  const now = input.now ?? new Date();
  const ops: PlanOp[] = [];
  const keptNotes: string[] = [];
  const diffs = orderKinds(input.diffs.map((d) => d.kind)).map((k) => input.diffs.find((d) => d.kind === k)!);

  for (const d of diffs) {
    const adapter = ADAPTERS[d.kind];
    for (const item of d.onlyInSource) {
      const readOnly = adapter.readOnly?.(item);
      ops.push({ seq: 0, kind: d.kind, key: item.key, action: readOnly ? "conflict" : "create", data: item.data, reason: readOnly });
    }
    for (const c of d.changed) {
      const reason = adapter.readOnly?.(c.source) ?? adapter.conflict?.(c.source, c.target);
      const kept = reason ? [] : (adapter.targetOnly?.(c.source.data, c.target.data) ?? []);
      if (kept.length) {
        const shown = kept.slice(0, 5).map((k) => `"${k}"`).join(", ");
        keptNotes.push(`${d.kind} ${c.key}: ${kept.length} link(s) that only the target has will be kept: ${shown}${kept.length > 5 ? "..." : ""}`);
      }
      ops.push({
        seq: 0,
        kind: d.kind,
        key: c.key,
        action: reason ? "conflict" : "update",
        data: c.source.data,
        targetId: c.target.id,
        targetHash: hashData(c.target.data),
        targetData: c.target.data,
        changes: c.changes,
        reason,
      });
    }
  }
  ops.forEach((op, i) => (op.seq = i + 1));

  // Refs that this plan will create itself are fine; everything else must already exist in the target.
  const willCreate = new Set(
    ops
      .filter((o) => o.action === "create")
      .flatMap((o) => [ADAPTERS[o.kind].refFor?.(o.key), ...(ADAPTERS[o.kind].createsRefs?.(o.key, o.data) ?? [])])
      .filter((r): r is string => Boolean(r)),
  );

  const warnings: string[] = [...keptNotes];
  const unmappable = new Set<string>();
  const toUpload = new Set<string>();
  const files: Record<string, FileSource> = {};
  let missingOwners = 0;
  // Look every reference up in the target at once; the loop below then reads from the cache.
  const lookups = new Set<string>();
  for (const op of ops) {
    if (op.action === "conflict") continue;
    const owner = ADAPTERS[op.kind].ownerRef?.(op.data);
    if (owner) lookups.add(owner);
    for (const ref of collectRefs(op.data)) lookups.add(ref);
  }
  const toLook = [...lookups].filter((r) => !r.startsWith(UNRESOLVED_PREFIX) && !willCreate.has(r));
  // Files and products in batches first; on a big catalog that is thousands of lookups.
  await input.resolver.prefetch(toLook);
  await Promise.all(toLook.map((r) => input.resolver.resolve(r)));
  for (const op of ops) {
    if (op.action === "conflict") continue;
    const owner = ADAPTERS[op.kind].ownerRef?.(op.data);
    if (owner && !owner.startsWith(UNRESOLVED_PREFIX) && !willCreate.has(owner) && !(await input.resolver.resolve(owner))) {
      op.action = "conflict";
      op.reason = `${owner.slice(REF_PREFIX.length)} doesn't exist in the target; create it first`;
      missingOwners++;
      continue;
    }
    const missing: string[] = [];
    for (const ref of collectRefs(op.data)) {
      if (ref.startsWith(UNRESOLVED_PREFIX)) {
        unmappable.add(ref);
        missing.push(ref);
      } else if (!willCreate.has(ref) && !(await input.resolver.resolve(ref))) {
        const source = ref.startsWith(`${REF_PREFIX}File/`) ? input.files?.[ref] : undefined;
        if (source) {
          toUpload.add(ref);
          files[ref] = source;
        } else {
          missing.push(ref);
        }
      }
    }
    if (missing.length) {
      op.missingRefs = missing.sort();
      warnings.push(`${op.kind} ${op.key}: references not found in target: ${op.missingRefs.join(", ")}`);
    }
  }
  if (unmappable.size) {
    warnings.unshift(
      `${unmappable.size} reference(s) point at resource types that can't be matched across stores (variants, articles...). Those values will be left out.`,
    );
  }
  if (toUpload.size) {
    warnings.push(`${toUpload.size} file(s) don't exist in the target and will be uploaded from the source when applied.`);
  }
  const conflicts = ops.filter((o) => o.action === "conflict").length;
  if (missingOwners) {
    warnings.unshift(`${missingOwners} value(s) belong to something that doesn't exist in the target (a product, variant, collection, page...); they will be skipped.`);
  }
  const otherConflicts = conflicts - missingOwners;
  if (otherConflicts) warnings.unshift(`${otherConflicts} conflict(s) need a manual fix in the target; they will be skipped.`);

  return {
    id: randomUUID(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
    source: input.source,
    target: input.target,
    kinds: diffs.map((d) => d.kind),
    ops,
    onlyInTarget: diffs.filter((d) => d.onlyInTarget.length).map((d) => ({ kind: d.kind, keys: d.onlyInTarget.map((i) => i.key) })),
    skipped: input.skipped ?? [],
    warnings,
    files,
    fetchOptions: input.fetchOptions,
    status: "pending",
  };
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SYNC_STATE_DIR ?? join(homedir(), ".shopify-store-sync");
}

/** Plan files older than this are removed whenever a new plan is saved. They expire after an hour anyway. */
export const PLAN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** How many plans stay in memory. Older ones are read again from disk when asked for. */
export const PLANS_IN_MEMORY = 5;

/** What a list of plans shows. Kept in a small file next to each plan, so listing never reads whole plans. */
export interface PlanSummary {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: Plan["status"];
  source: Plan["source"];
  target: Plan["target"];
  /** Number of steps. */
  ops: number;
}

export function planSummary(plan: Plan): PlanSummary {
  const { id, createdAt, expiresAt, status, source, target } = plan;
  return { id, createdAt, expiresAt, status, source: { alias: source.alias, domain: source.domain }, target: { alias: target.alias, domain: target.domain }, ops: plan.ops.length };
}

const PLAN_ID = /^[0-9a-f-]{36}$/;
const PLAN_FILE = /^([0-9a-f-]{36})\.json$/;
const SUMMARY_FILE = /^([0-9a-f-]{36})\.summary\.json$/;
const STATUSES = new Set<string>(["pending", "applied", "partially_applied", "failed"]);
const isStoreRef = (v: unknown): v is Plan["source"] =>
  Boolean(v) && typeof (v as Plan["source"]).alias === "string" && typeof (v as Plan["source"]).domain === "string";

/**
 * Plans are kept on disk so they survive an MCP server restart, and the few most recent in memory.
 * A plan holds the store content it would write, so a big one can run to hundreds of megabytes.
 */
export class PlanStore {
  /** Most recently used last. */
  private readonly plans = new Map<string, Plan>();
  /** Plans that couldn't be written to disk: memory is their only copy, so they are never dropped from it. */
  private readonly unsaved = new Set<string>();
  private readonly dir: string;

  constructor(dir = join(stateDir(), "plans")) {
    this.dir = dir;
  }

  private planFile(id: string) {
    return join(this.dir, `${id}.json`);
  }

  private summaryFile(id: string) {
    return join(this.dir, `${id}.summary.json`);
  }

  private remember(plan: Plan): void {
    this.plans.delete(plan.id);
    this.plans.set(plan.id, plan);
    for (const id of this.plans.keys()) {
      if (this.plans.size <= PLANS_IN_MEMORY) break;
      if (id !== plan.id && !this.unsaved.has(id)) this.plans.delete(id);
    }
  }

  /**
   * Keep the plan, in memory and on disk. Returns undefined when it is on disk, or why it couldn't be
   * written there (then it lasts only as long as this process).
   */
  save(plan: Plan): string | undefined {
    let problem: string | undefined;
    try {
      mkdirSync(this.dir, { recursive: true });
      // No indentation: on a big catalog that alone is a third of the file.
      writeFileSync(this.planFile(plan.id), JSON.stringify(plan), { mode: 0o600 });
      this.unsaved.delete(plan.id);
      try {
        writeFileSync(this.summaryFile(plan.id), JSON.stringify(planSummary(plan)), { mode: 0o600 });
      } catch {
        /* the list reads the plan itself instead */
      }
    } catch (e) {
      this.unsaved.add(plan.id);
      problem = e instanceof RangeError ? "it is too large to write as one file" : (e as Error).message;
    }
    this.remember(plan);
    try {
      this.prune();
    } catch {
      /* pruning is best-effort */
    }
    return problem;
  }

  /** Delete plan files that are long past their expiry; they hold store content. */
  prune(now = Date.now()): number {
    let removed = 0;
    const files = readdirSync(this.dir);
    const plans = new Set(files.map((f) => PLAN_FILE.exec(f)?.[1]).filter(Boolean));
    for (const f of files) {
      const id = PLAN_FILE.exec(f)?.[1];
      const orphan = SUMMARY_FILE.exec(f)?.[1];
      try {
        if (id && now - statSync(join(this.dir, f)).mtimeMs > PLAN_KEEP_MS) {
          rmSync(join(this.dir, f));
          rmSync(this.summaryFile(id), { force: true });
          this.plans.delete(id);
          removed++;
        } else if (orphan && !plans.has(orphan)) {
          rmSync(join(this.dir, f), { force: true });
        }
      } catch {
        /* someone else removed it */
      }
    }
    return removed;
  }

  /** The plan file as written, or undefined when it is missing or damaged. Not kept in memory. */
  private read(id: string): Plan | undefined {
    if (!PLAN_ID.test(id)) return undefined;
    const file = this.planFile(id);
    if (!existsSync(file)) return undefined;
    let plan: Plan;
    try {
      plan = JSON.parse(readFileSync(file, "utf8")) as Plan;
    } catch {
      return undefined; // a half-written or damaged file is treated as no plan
    }
    if (!plan || plan.id !== id || !Array.isArray(plan.ops)) return undefined;
    return plan;
  }

  get(id: string): Plan | undefined {
    const plan = this.plans.get(id) ?? this.read(id);
    if (plan) this.remember(plan);
    return plan;
  }

  private readSummary(id: string): PlanSummary | undefined {
    try {
      const s = JSON.parse(readFileSync(this.summaryFile(id), "utf8")) as PlanSummary;
      if (
        s?.id === id &&
        typeof s.createdAt === "string" &&
        typeof s.expiresAt === "string" &&
        STATUSES.has(s.status) &&
        isStoreRef(s.source) &&
        isStoreRef(s.target) &&
        Number.isInteger(s.ops)
      ) {
        return s;
      }
    } catch {
      /* missing or damaged: read the plan instead */
    }
    // A plan saved before summaries existed (or whose summary is damaged): read it once, and write its summary for next time.
    const plan = this.read(id);
    if (!plan) return undefined;
    const summary = planSummary(plan);
    try {
      writeFileSync(this.summaryFile(id), JSON.stringify(summary), { mode: 0o600 });
    } catch {
      /* best-effort */
    }
    return summary;
  }

  /** Every plan kept, in no particular order, without reading whole plans from disk. */
  list(): PlanSummary[] {
    const out = new Map<string, PlanSummary>();
    for (const plan of this.plans.values()) out.set(plan.id, planSummary(plan));
    let files: string[] = [];
    try {
      files = readdirSync(this.dir);
    } catch {
      /* no dir yet */
    }
    for (const f of files) {
      const id = PLAN_FILE.exec(f)?.[1];
      if (!id || out.has(id)) continue;
      const summary = this.readSummary(id);
      if (summary) out.set(id, summary);
    }
    return [...out.values()];
  }
}
