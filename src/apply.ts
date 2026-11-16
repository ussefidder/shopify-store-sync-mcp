import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashData } from "./diff.js";
import { collectRefs, mapStrings, REF_PREFIX, RefToGidResolver } from "./refs.js";
import { ADAPTERS, orderKinds, type Item, type ResourceKind } from "./resources/index.js";
import { envNumber, type AdminClient } from "./shopify/client.js";
import { BulkUnavailable, bulkThreshold } from "./shopify/bulk.js";
import { forKeys } from "./narrow.js";
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
  /** Called as the apply moves along: steps finished, steps in total, and what just happened. */
  onProgress?: (done: number, total: number, message: string) => void;
  /** Called when the apply moves to its next phase (checking the target, second pass...). */
  onPhase?: (message: string) => void;
  /** Called with every result as it is recorded (a later pass can replace an earlier result for the same step). */
  onResult?: (result: OpResult) => void;
  /** Aborted to cancel: nothing more is started, and running bulk operations are stopped on Shopify's side. */
  signal?: AbortSignal;
  /** Called with the id of each Shopify bulk operation the apply starts. */
  onBulkOperation?: (id: string) => void;
  /** During a bulk write: the kind, about how many items Shopify has written, and how many are in it. */
  onBulkProgress?: (kind: ResourceKind, written: number, total: number) => void;
}

/** How many independent writes run at once (products, pages, redirects...). */
export const writeConcurrency = () => envNumber("SYNC_WRITE_CONCURRENCY", 4);

/** Run each lane's items in order, a few lanes at a time. */
async function runLanes<T>(lanes: T[][], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < lanes.length) for (const item of lanes[next++]!) await fn(item);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, lanes.length)) }, worker));
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
  if (target.protected && opts.confirm?.trim().toLowerCase() !== target.domain.toLowerCase()) {
    // The domain is deliberately not repeated here: the confirmation has to come from a person who knows it.
    throw new ApplyRefused(
      opts.confirm
        ? `store "${target.alias}" is protected and the confirmation doesn't match its myshopify domain.`
        : `store "${target.alias}" is protected. A person has to confirm by giving the store's myshopify domain (command line: --confirm <domain>).`,
    );
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

/** The current target state of the items `ops` touch, per resource type, read as narrowly as each type allows. */
async function readKeys(client: AdminClient, plan: Plan, ops: PlanOp[]): Promise<Map<ResourceKind, Item[]>> {
  const kinds = [...new Set(ops.map((o) => o.kind))];
  const read = await Promise.all(
    kinds.map(async (k) => {
      const keys = ops.filter((o) => o.kind === k).map((o) => o.key);
      const snap = await takeSnapshot(client, [k], forKeys(plan.fetchOptions, k, keys));
      const wanted = new Set(keys);
      return [k, (snap.resources[k]?.items ?? []).filter((i) => wanted.has(i.key))] as const;
    }),
  );
  return new Map(read);
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
  // Only the items the plan touches are read again, not every item of their types.
  const kinds = [...new Set(runnable.map((o) => o.kind))];
  opts.onPhase?.(`checking ${plan.target.alias} hasn't changed since the plan (${runnable.length} item${runnable.length === 1 ? "" : "s"})`);
  const current = await readKeys(client, plan, runnable);
  const currentByKind = new Map(kinds.map((k) => [k, new Map((current.get(k) ?? []).map((i) => [i.key, i]))]));
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

  let finished = 0;
  const total = ready.length;
  // What this apply was to create and couldn't. Whatever depends on it fails at once, with that as the
  // reason, instead of being looked up in the target one item at a time.
  const notWritten = new Set<string>();
  const opBySeq = new Map(plan.ops.map((o) => [o.seq, o]));
  const blockedBy = (data: unknown): string | undefined => {
    if (!notWritten.size) return undefined;
    for (const r of collectRefs(data)) if (notWritten.has(r)) return r;
    return undefined;
  };
  const blockedMessage = (ref: string) => `not written: it belongs to ${ref.slice(REF_PREFIX.length)}, which this apply could not create`;

  const run = async (op: PlanOp, pass: 1 | 2): Promise<void> => {
    const adapter = ADAPTERS[op.kind];
    let data = dropUnmappable(op.data, op.kind);
    if (opts.signal?.aborted) {
      if (pass === 1) upsertResult({ seq: op.seq, kind: op.kind, key: op.key, outcome: "skipped", message: "the apply was cancelled" });
      return;
    }
    try {
      const blocked = blockedBy(data);
      if (blocked) throw new Error(blockedMessage(blocked));
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
    if (pass === 1) opts.onProgress?.(++finished, total, `${op.kind} ${op.key}`);
  };

  const upsertResult = (r: OpResult) => {
    const i = results.findIndex((x) => x.seq === r.seq);
    if (i >= 0) results[i] = r;
    else results.push(r);
    const op = opBySeq.get(r.seq);
    if (op?.action === "create") {
      const adapter = ADAPTERS[op.kind];
      const refs = [adapter.refFor?.(op.key), ...(adapter.createsRefs?.(op.key, op.data) ?? [])].filter((x): x is string => Boolean(x));
      for (const ref of refs) {
        if (r.outcome === "failed") notWritten.add(ref);
        else notWritten.delete(ref);
      }
    }
    opts.onResult?.(r);
    audit(log, { plan: plan.id, target: plan.target.domain, source: plan.source.domain, ...r });
  };

  /**
   * Many items of one kind go in one Shopify bulk operation instead of one request each. Returns the
   * ops it didn't write (none, or all of them when the store won't run bulk writes).
   */
  const runBulk = async (kind: ResourceKind, ops: PlanOp[]): Promise<PlanOp[]> => {
    const adapter = ADAPTERS[kind];
    if (opts.signal?.aborted) return ops;
    opts.onPhase?.(`writing ${ops.length} ${kind} in one Shopify bulk operation`);
    // Files the target lacks are taken from the source's URLs by the bulk write itself (products).
    resolver.allowUploads = kind !== "products";
    const items: { op: PlanOp; data: Record<string, unknown> }[] = [];
    try {
      const dataOf = ops.map((op) => dropUnmappable(op.data, op.kind));
      await resolver.prefetch(dataOf.flatMap((d) => [...collectRefs(d)]).filter((r) => !notWritten.has(r)));
      for (const [i, op] of ops.entries()) {
        const blocked = blockedBy(dataOf[i]);
        if (blocked) {
          upsertResult({ seq: op.seq, kind, key: op.key, outcome: "failed", message: blockedMessage(blocked) });
          opts.onProgress?.(++finished, total, `${kind} ${op.key}`);
          continue;
        }
        const { value, missing } = await resolver.rewrite(dataOf[i]!);
        const notFile = missing.filter((r) => !(kind === "products" && plan.files?.[r]));
        if (notFile.length) {
          upsertResult({ seq: op.seq, kind, key: op.key, outcome: "failed", message: `references not found in target: ${notFile.join(", ")}` });
          opts.onProgress?.(++finished, total, `${kind} ${op.key}`);
        } else {
          items.push({ op, data: value });
        }
      }
      // Results come as each part finishes, then all together at the end; a later error (stock not
      // set after the product was written, say) replaces an earlier success.
      const reported = new Map<number, boolean>();
      const record = (i: number, r: { id?: string; error?: string }, final = false) => {
        const before = reported.get(i);
        // The final result always stands; before that, the first report does, except that an error replaces a success.
        if (before !== undefined && (final ? before === Boolean(r.error) : before || !r.error)) return;
        reported.set(i, Boolean(r.error));
        const { op } = items[i]!;
        if (r.error) {
          upsertResult({ seq: op.seq, kind, key: op.key, outcome: "failed", message: r.error });
        } else {
          const ref = adapter.refFor?.(op.key);
          if (ref && r.id && op.action === "create") resolver.remember(ref, r.id);
          upsertResult({ seq: op.seq, kind, key: op.key, outcome: op.action === "create" ? "created" : "updated" });
        }
        if (before === undefined) opts.onProgress?.(++finished, total, `${kind} ${op.key}`);
      };
      const res = await adapter.bulkWrite!(
        {
          client,
          resolver,
          files: plan.files ?? {},
          onPhase: opts.onPhase,
          onWritten: (n) => opts.onBulkProgress?.(kind, n, items.length),
          signal: opts.signal,
          onOperation: opts.onBulkOperation,
          // Results land in the audit log as each part finishes, not only at the end.
          onDone: record,
        },
        items.map((i) => ({ key: i.op.key, action: i.op.action === "create" ? "create" : "update", data: i.data })),
      );
      res.forEach((r, i) => record(i, r, true));
      return [];
    } catch (err) {
      if (!(err instanceof BulkUnavailable)) throw err;
      opts.onPhase?.(`${err.message}; writing them one by one instead`);
      // Files looked up without uploading are looked up again, this time uploading what's missing.
      await resolver.forgetMisses(`shopify://File/`);
      return ops.filter((op) => !results.some((r) => r.seq === op.seq));
    } finally {
      resolver.allowUploads = true;
      // Files looked up without uploading are looked up again by later kinds, which do upload.
      if (kind === "products") await resolver.forgetMisses(`shopify://File/`);
    }
  };

  if (ready.length) opts.onPhase?.(`writing ${ready.length} step${ready.length === 1 ? "" : "s"} to ${plan.target.alias}`);
  // Kinds go in dependency order. Inside a kind whose items don't depend on each other, a few are
  // written at a time; items that share a lane (the same product, say) still go one after the other.
  for (const kind of orderKinds([...new Set(ready.map((o) => o.kind))])) {
    let ops = ready.filter((o) => o.kind === kind);
    const adapter = ADAPTERS[kind];
    if (adapter.bulkWrite) {
      const bulk = ops;
      if (bulk.length > bulkThreshold()) {
        const left = await runBulk(kind, bulk);
        ops = ops.filter((o) => !bulk.includes(o) || left.includes(o));
      }
    }
    if (!adapter.parallel || ops.length < 2) {
      for (const op of ops) await run(op, 1);
      continue;
    }
    const lanes = new Map<string, PlanOp[]>();
    for (const op of ops) {
      const lane = adapter.ownerRef?.(op.data) ?? op.key;
      lanes.set(lane, [...(lanes.get(lane) ?? []), op]);
    }
    await runLanes([...lanes.values()], writeConcurrency(), (op) => run(op, 1));
  }
  if (retry.length) {
    opts.onPhase?.(`second pass: finishing ${retry.length} item${retry.length === 1 ? "" : "s"} that point at each other`);
    const fresh = await readKeys(client, plan, retry);
    pass2Targets = new Map([...fresh].flatMap(([k, items]) => items.map((i) => [`${k}:${i.key}`, i] as const)));
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
