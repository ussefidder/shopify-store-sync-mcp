import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApplyOptions, OpResult } from "./apply.js";
import type { Plan } from "./plan.js";

/*
 * Applies that run in the background. A large plan takes longer than a client waits for one tool
 * call, so apply_plan starts it here and returns at once; apply_status reads how far it got.
 */

interface KindCount {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

export interface ApplyJob {
  planId: string;
  target: string;
  startedAt: number;
  finishedAt?: number;
  state: "running" | "done" | "error";
  phase: string;
  /** Steps that will be written (conflicts and drift skips count as finished at once). */
  steps: number;
  byKind: Record<string, KindCount>;
  results: Map<number, OpResult>;
  /** When the first write finished, to estimate the time left from the rate since then. */
  firstWriteAt?: number;
  /** The running bulk write: items Shopify has written so far, and how many results of that kind were in before it began. */
  bulk?: { kind: string; written: number; total: number; before: number };
  error?: string;
  planStatus?: Plan["status"];
  /** Shopify bulk operations this apply started, so they can be stopped even after a server restart. */
  bulkOperations: string[];
  cancelled?: boolean;
  abort: AbortController;
}

const KEEP_FINISHED = 20;

export class ApplyJobs {
  private jobs = new Map<string, ApplyJob>();
  private lastWrite = new Map<string, number>();

  /** `dir`: where each job's status is also written as JSON, so `shopify-store-sync-mcp status` can show it live. */
  constructor(private readonly dir?: string) {}

  /** Write the job's status file, at most every 2 seconds unless `force`. */
  private persist(job: ApplyJob, force = false) {
    if (!this.dir) return;
    const now = Date.now();
    if (!force && now - (this.lastWrite.get(job.planId) ?? 0) < 2000) return;
    this.lastWrite.set(job.planId, now);
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, `${job.planId}.json`), JSON.stringify({ ...jobStatus(job, now), updatedAt: new Date(now).toISOString() }, null, 2));
    } catch {
      // A status file is a convenience; the apply goes on without it.
    }
  }

  get(planId: string): ApplyJob | undefined {
    return this.jobs.get(planId);
  }

  latest(): ApplyJob | undefined {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
  }

  running(planId: string): boolean {
    return this.jobs.get(planId)?.state === "running";
  }

  /**
   * Start `run` in the background. It gets options that keep the job's counts up to date; anything
   * the caller passes in `opts` is kept and called as well.
   */
  start(
    plan: Plan,
    opts: ApplyOptions,
    run: (opts: ApplyOptions) => Promise<{ plan: Plan; results: OpResult[] }>,
    now: () => number = Date.now,
  ): ApplyJob {
    const selected = plan.ops.filter((o) => !opts.only?.length || opts.only.includes(o.seq));
    const byKind: Record<string, KindCount> = {};
    for (const o of selected) (byKind[o.kind] ??= { total: 0, created: 0, updated: 0, skipped: 0, failed: 0 }).total++;
    const job: ApplyJob = {
      planId: plan.id,
      target: plan.target.alias,
      startedAt: now(),
      state: "running",
      phase: "starting",
      steps: selected.length,
      byKind,
      results: new Map(),
      bulkOperations: [],
      abort: new AbortController(),
    };
    this.jobs.set(plan.id, job);
    this.prune();

    const tracked: ApplyOptions = {
      ...opts,
      signal: job.abort.signal,
      onBulkOperation: (id) => {
        job.bulkOperations.push(id);
        this.persist(job, true);
        opts.onBulkOperation?.(id);
      },
      onPhase: (m) => {
        job.phase = m;
        this.persist(job, true);
        opts.onPhase?.(m);
      },
      onResult: (r) => {
        job.results.set(r.seq, r);
        if (r.outcome !== "skipped") job.firstWriteAt ??= now();
        this.persist(job);
        opts.onResult?.(r);
      },
      onBulkProgress: (kind, written, total) => {
        const before = job.bulk?.kind === kind ? job.bulk.before : [...job.results.values()].filter((r) => r.kind === kind).length;
        job.bulk = written >= total ? undefined : { kind, written, total, before };
        this.persist(job);
        opts.onBulkProgress?.(kind, written, total);
      },
    };
    void run(tracked).then(
      ({ plan: done }) => {
        job.state = "done";
        job.planStatus = done.status;
        job.finishedAt = now();
        job.bulk = undefined;
        job.phase = "finished";
        this.persist(job, true);
      },
      (err: unknown) => {
        job.state = "error";
        job.error = err instanceof Error ? err.message : String(err);
        job.finishedAt = now();
        job.bulk = undefined;
        this.persist(job, true);
      },
    );
    this.persist(job, true);
    return job;
  }

  /** Stop a running apply: nothing more is started and its bulk operations are cancelled on Shopify's side. */
  cancel(planId: string): ApplyJob | undefined {
    const job = this.jobs.get(planId);
    if (!job || job.state !== "running") return undefined;
    job.cancelled = true;
    job.phase = "cancelling: stopping the bulk operations on Shopify's side and collecting what was written";
    job.abort.abort();
    this.persist(job, true);
    return job;
  }

  private prune() {
    const done = [...this.jobs.values()].filter((j) => j.state !== "running").sort((a, b) => a.startedAt - b.startedAt);
    for (const j of done.slice(0, Math.max(0, done.length - KEEP_FINISHED))) this.jobs.delete(j.planId);
  }
}

const minutes = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "under a minute" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/** What apply_status returns: counts per resource type, what's left, the time so far and an estimate of what remains. */
export function jobStatus(job: ApplyJob, now: number = Date.now(), failuresShown = 20, kind?: string) {
  const kinds: Record<string, KindCount & { left: number }> = {};
  for (const [k, c] of Object.entries(job.byKind)) kinds[k] = { ...c, created: 0, updated: 0, skipped: 0, failed: 0, left: c.total };
  for (const r of job.results.values()) {
    const c = kinds[r.kind];
    if (!c) continue;
    c[r.outcome]++;
    c.left--;
  }
  const sum = (f: keyof KindCount | "left") => Object.values(kinds).reduce((a, c) => a + c[f], 0);
  const finished = job.results.size;
  // Items Shopify has written in the running bulk operation but not reported yet count towards the rate.
  const bulk = job.bulk;
  const inFlight = bulk ? Math.max(0, bulk.written - ([...job.results.values()].filter((r) => r.kind === bulk.kind).length - bulk.before)) : 0;
  const elapsed = (job.finishedAt ?? now) - job.startedAt;
  let remaining: string | undefined;
  if (job.state === "running" && job.firstWriteAt) {
    const writing = now - job.firstWriteAt;
    const written = [...job.results.values()].filter((r) => r.outcome !== "skipped").length + inFlight;
    const left = job.steps - finished - inFlight;
    const done = written;
    if (done > 0 && writing > 5_000 && left > 0) remaining = minutes((writing / done) * left);
  }
  const allFailures = [...job.results.values()].filter((r) => r.outcome === "failed");
  const failures = kind ? allFailures.filter((r) => r.kind === kind) : allFailures;
  // The same reason usually repeats thousands of times: failures are counted per resource type and
  // reason, so the first cause (a product, say) isn't buried under what failed because of it.
  const reasons = new Map<string, { kind: string; reason: string; count: number; examples: string[]; firstMessage?: string }>();
  for (const r of allFailures) {
    const reason = (r.message ?? "no reason given").replace(/\S*\/\S*/g, "…").replace(/\d{3,}/g, "#").replace(/(…,? ?)+/g, "… ").trim().slice(0, 200);
    const g = reasons.get(`${r.kind}|${reason}`) ?? { kind: r.kind, reason, count: 0, examples: [], firstMessage: r.message };
    g.count++;
    if (g.examples.length < 3) g.examples.push(r.key);
    reasons.set(`${r.kind}|${reason}`, g);
  }
  return {
    plan_id: job.planId,
    target: job.target,
    state: job.state,
    cancelled: job.cancelled,
    planStatus: job.planStatus,
    phase: job.phase,
    progress: `${finished} of ${job.steps} steps finished${job.state === "running" ? ` (${Math.round((finished / Math.max(1, job.steps)) * 100)}%)` : ""}`,
    totals: { created: sum("created"), updated: sum("updated"), skipped: sum("skipped"), failed: sum("failed"), left: sum("left") },
    byResource: kinds,
    bulk: bulk ? `Shopify has written about ${bulk.written} of ${bulk.total} ${bulk.kind} in its bulk operation` : undefined,
    startedAt: new Date(job.startedAt).toISOString(),
    elapsed: minutes(elapsed),
    remaining,
    failureReasons: allFailures.length ? [...reasons.values()].sort((a, b) => b.count - a.count).slice(0, 10) : undefined,
    failures: failures.slice(-failuresShown).map((r) => ({ seq: r.seq, kind: r.kind, key: r.key, message: r.message })),
    moreFailures: failures.length > failuresShown ? failures.length - failuresShown : undefined,
    error: job.error,
    bulkOperations: job.bulkOperations.length ? job.bulkOperations : undefined,
    note:
      job.state === "running"
        ? job.cancelled
          ? "Cancelling. Call apply_status again in a minute to see what was written before it stopped."
          : "Still writing. Call apply_status again in a minute or two (or run `shopify-store-sync-mcp status --watch` in a terminal); every result is also in the audit log. cancel_apply stops it."
        : job.cancelled
          ? "Cancelled. What was written before stays written (this tool never deletes); run plan_sync again to see what is left."
          : "Finished. Every result is in the audit log.",
  };
}

export type JobFile = ReturnType<typeof jobStatus> & { updatedAt: string };

/** The status file of one apply, or of the most recent one. */
export function readJobFile(dir: string, planId?: string): JobFile | undefined {
  try {
    const name =
      planId ? `${planId}.json` : readdirSync(dir).filter((f) => f.endsWith(".json")).sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)[0];
    return name ? (JSON.parse(readFileSync(join(dir, name), "utf8")) as JobFile) : undefined;
  } catch {
    return undefined;
  }
}

/** One line for a terminal: written, failed and left, the bulk progress and the time left. */
export function jobLine(j: JobFile, now = Date.now()): string {
  const t = j.totals;
  const age = Math.round((now - Date.parse(j.updatedAt)) / 1000);
  const stale = j.state === "running" && age > 600 ? `  (no news for ${Math.round(age / 60)} min: is the server still running?)` : "";
  return [
    `${j.state}: ${j.progress}`,
    `${t.created + t.updated} written, ${t.failed} failed, ${t.left} left`,
    j.bulk,
    j.remaining ? `about ${j.remaining} left` : undefined,
    // While it runs, the time so far is counted here: the file is only rewritten when something happens.
    `elapsed ${j.state === "running" && j.startedAt ? minutes(now - Date.parse(j.startedAt)) : j.elapsed}`,
  ]
    .filter(Boolean)
    .join(" | ") + `\n  ${j.phase}${stale}`;
}
