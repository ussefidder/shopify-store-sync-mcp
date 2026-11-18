import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLANS_IN_MEMORY, PlanStore, type Plan } from "../src/plan.js";

/*
 * What has to hold on a big store: a plan can run to hundreds of megabytes, so plans stay out of
 * memory and out of plan listings.
 */

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const plan = (n: number, ops = 0): Plan => ({
  id: id(n),
  createdAt: `2026-11-17T10:00:0${n % 10}.000Z`,
  expiresAt: "2026-11-17T11:00:00.000Z",
  source: { alias: "a", domain: "a.myshopify.com" },
  target: { alias: "b", domain: "b.myshopify.com" },
  kinds: [],
  ops: Array.from({ length: ops }, (_, i) => ({ seq: i + 1, kind: "pages" as const, key: `p${i}`, action: "create" as const, data: { body: "x".repeat(100) } })),
  onlyInTarget: [],
  skipped: [],
  warnings: [],
  files: {},
  status: "pending",
});

describe("plans on a big store", () => {
  it("lists plans from their summaries, without reading the plans themselves", () => {
    const dir = tmp("plans-");
    new PlanStore(dir).save(plan(1, 3));
    // If the list read the plan, this damaged file would drop it from the list.
    writeFileSync(join(dir, `${id(1)}.json`), "{ not json");
    expect(new PlanStore(dir).list()).toEqual([
      { id: id(1), createdAt: plan(1).createdAt, expiresAt: plan(1).expiresAt, status: "pending", source: plan(1).source, target: plan(1).target, ops: 3 },
    ]);
  });

  it("lists a plan saved before summaries existed, and writes its summary for next time", () => {
    const dir = tmp("plans-");
    writeFileSync(join(dir, `${id(2)}.json`), JSON.stringify(plan(2, 2), null, 2));
    expect(new PlanStore(dir).list().map((p) => [p.id, p.ops])).toEqual([[id(2), 2]]);
    expect(JSON.parse(readFileSync(join(dir, `${id(2)}.summary.json`), "utf8"))).toMatchObject({ id: id(2), ops: 2, status: "pending" });
  });

  it("keeps the summary's status in step when an applied plan is saved again", () => {
    const dir = tmp("plans-");
    const store = new PlanStore(dir);
    const p = plan(3, 1);
    store.save(p);
    p.status = "partially_applied";
    store.save(p);
    expect(new PlanStore(dir).list().map((s) => s.status)).toEqual(["partially_applied"]);
  });

  it("writes plans without indentation", () => {
    const dir = tmp("plans-");
    new PlanStore(dir).save(plan(4, 2));
    expect(readFileSync(join(dir, `${id(4)}.json`), "utf8")).not.toContain("\n");
  });

  it("keeps only the most recent plans in memory and reads older ones from disk again", () => {
    const dir = tmp("plans-");
    const store = new PlanStore(dir);
    const count = PLANS_IN_MEMORY + 2;
    for (let n = 1; n <= count; n++) store.save(plan(n));
    // Gone from disk: the oldest ones are no longer in memory either, the newest still are.
    for (let n = 1; n <= count; n++) rmSync(join(dir, `${id(n)}.json`));
    expect(store.get(id(1))).toBeUndefined();
    expect(store.get(id(2))).toBeUndefined();
    expect(store.get(id(count))?.id).toBe(id(count));
    expect(store.get(id(3))?.id).toBe(id(3));
  });

  it("never drops a plan from memory when it couldn't be written to disk", () => {
    const notADir = join(tmp("plans-"), "file");
    writeFileSync(notADir, "");
    const store = new PlanStore(notADir);
    const problems = Array.from({ length: PLANS_IN_MEMORY + 3 }, (_, i) => store.save(plan(i + 1)));
    expect(problems.every((p) => typeof p === "string" && p.length > 0)).toBe(true);
    for (let n = 1; n <= PLANS_IN_MEMORY + 3; n++) expect(store.get(id(n))?.id).toBe(id(n));
    expect(store.list()).toHaveLength(PLANS_IN_MEMORY + 3);
  });

  it("removes an old plan's summary with it, and summaries left without a plan", () => {
    const dir = tmp("plans-");
    const store = new PlanStore(dir);
    store.save(plan(1));
    writeFileSync(join(dir, `${id(9)}.summary.json`), "{}");
    expect(store.prune(Date.now() + 8 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });
});
