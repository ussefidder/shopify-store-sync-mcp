import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashData } from "./diff.js";
import { collectRefs, mapStrings, RefToGidResolver } from "./refs.js";
import { ADAPTERS, type ResourceKind } from "./resources/index.js";
import type { AdminClient } from "./shopify/client.js";
import { takeSnapshot } from "./snapshot.js";
import { stateDir, type Plan, type PlanOp } from "./plan.js";

export type OpOutcome = "created" | "updated" | "skipped" | "failed";

export interface OpResult {
  seq: number;
  kind: ResourceKind;
  key: string;
  outcome: OpOutcome;
  message?: string;
}

export interface ApplyOptions {
  /** Required when the target store is marked protected: must equal the target's myshopify domain. */
  confirm?: string;
  /** Only apply these op sequence numbers (from the plan). Default: all. */
  only?: number[];
  now?: Date;
  auditLog?: string;
}

export class ApplyRefused extends Error {}

export function checkApplyAllowed(plan: Plan, target: AdminClient["store"], opts: ApplyOptions): void {
  const now = opts.now ?? new Date();
  if (plan.target.alias !== target.alias || plan.target.domain !== target.domain) {
    throw new ApplyRefused("plan target doesn't match the configured store");
  }
  if (plan.status !== "pending") throw new ApplyRefused(`plan was already ${plan.status.replace("_", " ")}; create a new plan`);
  if (now > new Date(plan.expiresAt)) throw new ApplyRefused("plan has expired; run plan_sync again so it reflects the current target");
  if (!target.allowWrites) {
    throw new ApplyRefused(`writes are disabled for store "${target.alias}". Set "allowWrites": true in its config to enable them.`);
  }
  if (target.protected && opts.confirm !== target.domain) {
    throw new ApplyRefused(`store "${target.alias}" is protected. Pass confirm="${target.domain}" to apply.`);
  }
}

function audit(file: string, entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    /* auditing must never break a sync */
  }
}

const touches = (v: unknown, refs: Set<string>) => [...collectRefs(v)].some((r) => refs.has(r));

/** Remove metaobject fields whose value contains any of `refs`. */
function stripFieldsWithRefs(data: Record<string, unknown>, refs: Set<string>): Record<string, unknown> {
  const fields = { ...((data.fields as Record<string, string>) ?? {}) };
  for (const [k, v] of Object.entries(fields)) {
    if (touches(v, refs)) delete fields[k];
  }
  return { ...data, fields };
}

/** Remove metaobject definition fields whose validations reference any of `refs` (e.g. a self-reference). */
function stripFieldDefsWithRefs(data: Record<string, unknown>, refs: Set<string>): Record<string, unknown> {
  return { ...data, fields: ((data.fields as unknown[]) ?? []).filter((f) => !touches(f, refs)) };
}

/** Kinds that can be written in two passes: first without the unresolved parts, then complete. */
const PARTIAL: Partial<Record<ResourceKind, (d: Record<string, unknown>, refs: Set<string>) => Record<string, unknown>>> = {
  metaobjects: stripFieldsWithRefs,
  metaobject_definitions: stripFieldDefsWithRefs,
};

type MenuItem = { resourceId?: string; items?: MenuItem[] };

/** A menu link to something that can't be matched is left out rather than sent with an empty target. */
function dropMenuItems(items: MenuItem[], refs: Set<string>): MenuItem[] {
  return items
    .filter((i) => !(i.resourceId && refs.has(i.resourceId)))
    .map((i) => (i.items ? { ...i, items: dropMenuItems(i.items, refs) } : i));
}

/** Drop values that can never be resolved (files, variants...) instead of sending a broken ref. */
function dropUnmappable(data: Record<string, unknown>, kind: ResourceKind): Record<string, unknown> {
  const unmappable = new Set([...collectRefs(data)].filter((r) => r.startsWith("shopify://unresolved/")));
  if (!unmappable.size) return data;
  if (kind === "metaobjects") return stripFieldsWithRefs(data, unmappable);
  if (kind === "menus") return { ...data, items: dropMenuItems((data.items as MenuItem[]) ?? [], unmappable) };
  return mapStrings(data, (s) => (unmappable.has(s) ? "" : s)) as Record<string, unknown>;
}

export async function applyPlan(plan: Plan, client: AdminClient, opts: ApplyOptions = {}): Promise<OpResult[]> {
  checkApplyAllowed(plan, client.store, opts);
  const log = opts.auditLog ?? process.env.SYNC_AUDIT_LOG ?? join(stateDir(), "audit.log");
  const resolver = new RefToGidResolver(client, new Map(Object.entries(plan.files ?? {})));
  const results: OpResult[] = [];

  const selected = plan.ops.filter((o) => !opts.only?.length || opts.only.includes(o.seq));
  const runnable: PlanOp[] = [];
  for (const op of selected) {
    if (op.action === "conflict") results.push({ seq: op.seq, kind: op.kind, key: op.key, outcome: "skipped", message: op.reason });
    else runnable.push(op);
  }

  // Drift check: re-read the target and skip anything that changed since the plan was made.
  const kinds = [...new Set(runnable.map((o) => o.kind))];
  const current = await takeSnapshot(client, kinds, plan.fetchOptions);
  const currentByKind = new Map(kinds.map((k) => [k, new Map((current.resources[k]?.items ?? []).map((i) => [i.key, i]))]));
  const ready: PlanOp[] = [];
  for (const op of runnable) {
    const now = currentByKind.get(op.kind)?.get(op.key);
    if (op.action === "create" && now) {
      results.push({ seq: op.seq, kind: op.kind, key: op.key, outcome: "skipped", message: "already exists in target now; re-run plan_sync" });
    } else if (op.action === "update" && (!now || hashData(now.data) !== op.targetHash)) {
      results.push({ seq: op.seq, kind: op.kind, key: op.key, outcome: "skipped", message: "target changed since the plan was made; re-run plan_sync" });
    } else {
      ready.push(op);
    }
  }

  const retry: PlanOp[] = [];
  /** Current target state, refreshed before pass 2 so updates see what pass 1 created. */
  let pass2Targets = new Map<string, { key: string; id: string; data: Record<string, unknown> }>();

  const run = async (op: PlanOp, pass: 1 | 2): Promise<void> => {
    const adapter = ADAPTERS[op.kind];
    let data = dropUnmappable(op.data, op.kind);
    try {
      const { value, missing } = await resolver.rewrite(data);
      data = value;
      const strip = PARTIAL[op.kind];
      if (missing.length) {
        if (strip && pass === 1) {
          // Probably points at something later in this plan (or at itself): write what we can now, finish in pass 2.
          data = strip(dropUnmappable(op.data, op.kind), new Set(missing));
          data = (await resolver.rewrite(data)).value;
          retry.push(op);
        } else {
          throw new Error(`references not found in target: ${missing.join(", ")}`);
        }
      }

      const target = (pass === 2 && pass2Targets.get(`${op.kind}:${op.key}`)) || {
        key: op.key,
        id: op.targetId ?? "",
        data: op.targetData ?? {},
      };
      let outcome: OpOutcome;
      if (op.action === "create" && pass === 1) {
        const id = await adapter.create({ client, resolver }, op.key, data);
        const ref = adapter.refFor?.(op.key);
        if (ref) resolver.remember(ref, id);
        outcome = "created";
      } else {
        await adapter.update({ client, resolver }, target, data);
        outcome = op.action === "create" ? "created" : "updated";
      }
      const msg = retry.includes(op) && pass === 1 ? "partially written; finishing references in a second pass" : undefined;
      upsertResult({ seq: op.seq, kind: op.kind, key: op.key, outcome, message: msg });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (PARTIAL[op.kind] && pass === 1 && !retry.includes(op)) retry.push(op);
      upsertResult({ seq: op.seq, kind: op.kind, key: op.key, outcome: "failed", message });
    }
  };

  const upsertResult = (r: OpResult) => {
    const i = results.findIndex((x) => x.seq === r.seq);
    if (i >= 0) results[i] = r;
    else results.push(r);
    audit(log, { plan: plan.id, target: plan.target.domain, source: plan.source.domain, ...r });
  };

  for (const op of ready) await run(op, 1);
  if (retry.length) {
    const retryKinds = [...new Set(retry.map((o) => o.kind))];
    const fresh = await takeSnapshot(client, retryKinds, plan.fetchOptions);
    pass2Targets = new Map(retryKinds.flatMap((k) => (fresh.resources[k]?.items ?? []).map((i) => [`${k}:${i.key}`, i] as const)));
    for (const op of retry) {
      // An op that failed outright in pass 1 and still doesn't exist must be created, not updated.
      if (op.action === "create" && !pass2Targets.has(`${op.kind}:${op.key}`)) await run({ ...op }, 1);
      else await run(op, 2);
    }
  }

  results.sort((a, b) => a.seq - b.seq);
  if (resolver.uploaded.length) audit(log, { plan: plan.id, target: plan.target.domain, uploadedFiles: resolver.uploaded });
  const failed = results.filter((r) => r.outcome === "failed").length;
  const done = results.filter((r) => r.outcome === "created" || r.outcome === "updated").length;
  if (opts.only?.length && selected.length < plan.ops.length) {
    // Partial run: keep the plan usable for the remaining ops (applied ones will show as drifted).
    plan.status = "pending";
  } else {
    plan.status = failed === 0 ? "applied" : done > 0 ? "partially_applied" : "failed";
  }
  return results;
}
