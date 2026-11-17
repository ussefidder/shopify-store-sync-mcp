import { envNumber, type AdminClient } from "./client.js";
import type { LineResult } from "./bulk.js";

/*
 * Batched writes: several writes in one request (as aliases), several requests at once. Measured on
 * a live store with 4,000 products, this is several times faster than Shopify bulk operations,
 * which work through about one write every five seconds each, five at most.
 */

/** How many write requests run at once (SYNC_WRITE_REQUESTS, default 12). */
export const writeRequests = () => Math.max(1, Math.min(32, envNumber("SYNC_WRITE_REQUESTS", 12)));
/** `SYNC_BULK_WRITES=true` writes large sets through Shopify bulk operations instead of batched requests. */
export const bulkWrites = (env: NodeJS.ProcessEnv = process.env) => env.SYNC_BULK_WRITES === "true";

export interface BatchSpec {
  /** The variables one write takes, with # where its number goes: "$input#: ProductSetInput!". */
  vars: string;
  /** The mutation field of one write, with the same #: "productSet(input: $input#) { product { id } }". */
  field: string;
  /** Name of that field, so results come back shaped like a bulk operation's: `data.<root>`. */
  root: string;
  /** At most this many writes in one request. */
  perRequest: number;
  /** Optional: how heavy a write is (a product's variants, say), and how much weight one request may carry. */
  weight?: (line: Record<string, unknown>) => number;
  maxWeight?: number;
  /** True when sending the same write twice is harmless, so a failed request can be sent again. */
  idempotent?: (line: Record<string, unknown>) => boolean;
}

export interface BatchOptions {
  concurrency?: number;
  signal?: AbortSignal;
  /** Called after each request with the index of its first line and its results, in line order. */
  onResults?: (start: number, results: LineResult[]) => void;
}

/** Split `lines` into consecutive requests by count and weight. */
export function groupLines(lines: Record<string, unknown>[], spec: BatchSpec): { start: number; lines: Record<string, unknown>[] }[] {
  const groups: { start: number; lines: Record<string, unknown>[] }[] = [];
  let current: Record<string, unknown>[] = [];
  let weight = 0;
  lines.forEach((line, i) => {
    const w = spec.weight?.(line) ?? 1;
    if (current.length && (current.length >= spec.perRequest || (spec.maxWeight !== undefined && weight + w > spec.maxWeight))) {
      groups.push({ start: i - current.length, lines: current });
      current = [];
      weight = 0;
    }
    current.push(line);
    weight += w;
  });
  if (current.length) groups.push({ start: lines.length - current.length, lines: current });
  return groups;
}

/**
 * Run one write per entry of `lines` (its variables), a few per request and a few requests at once.
 * Returns one result per line, in line order, shaped like bulkMutation's.
 */
export async function batchedMutation(client: AdminClient, spec: BatchSpec, lines: Record<string, unknown>[], opts: BatchOptions = {}): Promise<LineResult[]> {
  const out: LineResult[] = lines.map(() => ({ errors: [{ message: "not written: the apply was cancelled" }] }));
  const groups = groupLines(lines, spec);
  let next = 0;

  const send = async (g: (typeof groups)[number]): Promise<LineResult[]> => {
    const at = (text: string, i: number) => text.replaceAll("#", String(i));
    const query = "mutation Batch(" + g.lines.map((_, i) => at(spec.vars, i)).join(", ") + ") { " + g.lines.map((_, i) => "w" + i + ": " + at(spec.field, i)).join(" ") + " }";
    const variables: Record<string, unknown> = {};
    g.lines.forEach((line, i) => {
      for (const [k, v] of Object.entries(line)) variables[`${k}${i}`] = v;
    });
    const data = await client.request<Record<string, Record<string, unknown> | null>>(query, variables);
    return g.lines.map((_, i) => (data[`w${i}`] ? { data: { [spec.root]: data[`w${i}`] } } : { errors: [{ message: "no result for this write" }], unknown: true }));
  };

  const worker = async () => {
    while (next < groups.length && !opts.signal?.aborted) {
      const g = groups[next++]!;
      let results: LineResult[];
      try {
        results = await send(g);
      } catch (first) {
        try {
          // Writes that are safe to repeat are sent once more; others may have gone through, so they aren't.
          if (!g.lines.every((l) => spec.idempotent?.(l))) throw first;
          results = await send(g);
        } catch (e) {
          // Some writes of the request may have been saved before it failed: the caller can check.
          const message = `not written: ${(e as Error).message}`;
          results = g.lines.map(() => ({ errors: [{ message }], unknown: true }));
        }
      }
      results.forEach((r, i) => (out[g.start + i] = r));
      opts.onResults?.(g.start, results);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? writeRequests(), groups.length) }, worker));
  return out;
}
