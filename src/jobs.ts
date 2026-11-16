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
}

const KEEP_FINISHED = 20;

export class ApplyJobs {
  private jobs = new Map<string, ApplyJob>();

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
    };
    this.jobs.set(plan.id, job);
    this.prune();

    const tracked: ApplyOptions = {
      ...opts,
      onPhase: (m) => {
        job.phase = m;
        opts.onPhase?.(m);
      },
      onResult: (r) => {
        job.results.set(r.seq, r);
        if (r.outcome !== "skipped") job.firstWriteAt ??= now();
        opts.onResult?.(r);
      },
      onBulkProgress: (kind, written, total) => {
        const before = job.bulk?.kind === kind ? job.bulk.before : [...job.results.values()].filter((r) => r.kind === kind).length;
        job.bulk = written >= total ? undefined : { kind, written, total, before };
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
      },
      (err: unknown) => {
        job.state = "error";
        job.error = err instanceof Error ? err.message : String(err);
        job.finishedAt = now();
        job.bulk = undefined;
      },
    );
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
export function jobStatus(job: ApplyJob, now: number = Date.now(), failuresShown = 20) {
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
  const failures = [...job.results.values()].filter((r) => r.outcome === "failed");
  return {
    plan_id: job.planId,
    target: job.target,
    state: job.state,
    planStatus: job.planStatus,
    phase: job.phase,
    progress: `${finished} of ${job.steps} steps finished${job.state === "running" ? ` (${Math.round((finished / Math.max(1, job.steps)) * 100)}%)` : ""}`,
    totals: { created: sum("created"), updated: sum("updated"), skipped: sum("skipped"), failed: sum("failed"), left: sum("left") },
    byResource: kinds,
    bulk: bulk ? `Shopify has written about ${bulk.written} of ${bulk.total} ${bulk.kind} in its bulk operation` : undefined,
    elapsed: minutes(elapsed),
    remaining,
    failures: failures.slice(-failuresShown).map((r) => ({ seq: r.seq, kind: r.kind, key: r.key, message: r.message })),
    moreFailures: failures.length > failuresShown ? failures.length - failuresShown : undefined,
    error: job.error,
    note:
      job.state === "running"
        ? "Still writing. Call apply_status again in a minute or two; every result is also in the audit log."
        : "Finished. Every result is in the audit log.",
  };
}
