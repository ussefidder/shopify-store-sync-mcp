import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hashData, type FieldChange, type ResourceDiff } from "./diff.js";
import { collectRefs, REF_PREFIX, UNRESOLVED_PREFIX, type FileSource, type RefToGidResolver } from "./refs.js";
import { ADAPTERS, orderKinds, type ResourceKind } from "./resources/index.js";

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
  now?: Date;
}

export async function buildPlan(input: BuildPlanInput): Promise<Plan> {
  const now = input.now ?? new Date();
  const ops: PlanOp[] = [];
  const diffs = orderKinds(input.diffs.map((d) => d.kind)).map((k) => input.diffs.find((d) => d.kind === k)!);

  for (const d of diffs) {
    const adapter = ADAPTERS[d.kind];
    for (const item of d.onlyInSource) {
      ops.push({ seq: 0, kind: d.kind, key: item.key, action: "create", data: item.data });
    }
    for (const c of d.changed) {
      const reason = adapter.conflict?.(c.source, c.target);
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
      .map((o) => ADAPTERS[o.kind].refFor?.(o.key))
      .filter((r): r is string => Boolean(r)),
  );

  const warnings: string[] = [];
  const unmappable = new Set<string>();
  const toUpload = new Set<string>();
  const files: Record<string, FileSource> = {};
  let missingOwners = 0;
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
    warnings.unshift(`${missingOwners} value(s) belong to products or collections that don't exist in the target; they will be skipped.`);
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
    status: "pending",
  };
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SYNC_STATE_DIR ?? join(homedir(), ".shopify-store-sync");
}

/** Plans are kept in memory and on disk so they survive an MCP server restart. */
export class PlanStore {
  private readonly plans = new Map<string, Plan>();
  private readonly dir: string;

  constructor(dir = join(stateDir(), "plans")) {
    this.dir = dir;
  }

  save(plan: Plan): void {
    this.plans.set(plan.id, plan);
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, `${plan.id}.json`), JSON.stringify(plan, null, 2), { mode: 0o600 });
    } catch {
      /* disk persistence is best-effort */
    }
  }

  get(id: string): Plan | undefined {
    if (this.plans.has(id)) return this.plans.get(id);
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const file = join(this.dir, `${id}.json`);
    if (!existsSync(file)) return undefined;
    const plan = JSON.parse(readFileSync(file, "utf8")) as Plan;
    this.plans.set(id, plan);
    return plan;
  }

  list(): Plan[] {
    const ids = new Set(this.plans.keys());
    try {
      for (const f of readdirSync(this.dir)) if (f.endsWith(".json")) ids.add(f.slice(0, -5));
    } catch {
      /* no dir yet */
    }
    return [...ids].map((id) => this.get(id)).filter((p): p is Plan => Boolean(p));
  }
}
