import { envNumber, ShopifyError, type AdminClient } from "./client.js";

/** Above this many items a read or write goes through a bulk operation instead of single requests. */
export const bulkThreshold = () => envNumber("SYNC_BULK_THRESHOLD", 250);
/**
 * How long a bulk operation may go without writing anything more before it is given up on. A big
 * one can run for hours; only one that has stopped moving is abandoned.
 */
export const bulkTimeoutMs = () => envNumber("SYNC_BULK_TIMEOUT_MS", 30 * 60_000);

/*
 * Bulk reads: Shopify runs the whole query on its side and hands back one JSONL file, so a large
 * catalog is one request and a short wait instead of hundreds of rate-limited pages.
 * bulkOperationRunQuery is a mutation by name only: it reads, it never changes store data.
 */

const RUN = /* GraphQL */ `
  mutation BulkRead($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message code }
    }
  }
`;

const POLL = /* GraphQL */ `
  query BulkStatus($id: ID!) {
    node(id: $id) {
      ... on BulkOperation { id status errorCode objectCount url partialDataUrl }
    }
  }
`;

export type Download = (url: string) => Promise<string>;

const defaultDownload: Download = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok) throw new Error(`download failed with HTTP ${res.status}`);
  return res.text();
};

/** Where bulk files go and come from, and how polling waits. Tests swap these for in-memory ones. */
export const bulkIO: { download: Download; upload: Upload; wait: (ms: number) => Promise<void> } = {
  download: (url) => defaultDownload(url),
  upload: (url, form) => defaultUpload(url, form),
  wait: (ms) => sleep(ms),
};

export interface BulkOptions {
  download?: Download;
  pollMs?: number;
  timeoutMs?: number;
  wait?: (ms: number) => Promise<void>;
  /** Called while waiting, with the number of objects Shopify has written so far. */
  onProgress?: (objects: number) => void;
  /** When aborted, running operations are cancelled on Shopify's side and what they had written is returned. */
  signal?: AbortSignal;
  /** Called with the id of each operation as it starts. */
  onStart?: (id: string) => void;
}

const CANCEL = /* GraphQL */ `
  mutation BulkCancel($id: ID!) {
    bulkOperationCancel(id: $id) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

/** Ask Shopify to stop bulk operations. What they already wrote stays written. */
export async function cancelBulkOperations(client: AdminClient, ids: string[]): Promise<{ id: string; error?: string }[]> {
  const out: { id: string; error?: string }[] = [];
  for (const id of ids) {
    try {
      const d = await client.request<{ bulkOperationCancel: { userErrors: { message: string }[] } }>(CANCEL, { id });
      out.push({ id, error: d.bulkOperationCancel.userErrors[0]?.message });
    } catch (e) {
      out.push({ id, error: (e as Error).message });
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run a bulk query and return its rows. Nested rows carry `__parentId`. */
export async function bulkQuery(client: AdminClient, query: string, opts: BulkOptions = {}): Promise<Record<string, any>[]> {
  const domain = client.store.domain;
  const started = await client.request<{
    bulkOperationRunQuery: { bulkOperation: { id: string } | null; userErrors: { message: string; code?: string }[] };
  }>(RUN, { query });
  const { bulkOperation, userErrors } = started.bulkOperationRunQuery;
  if (userErrors?.length || !bulkOperation) {
    throw new ShopifyError(`${domain}: bulk read could not start: ${userErrors.map((e) => e.message).join("; ") || "no operation returned"}`, userErrors);
  }

  return pollAndDownload(client, bulkOperation.id, opts);
}

/** Wait for a bulk operation to finish and return the rows of its result file. */
async function pollAndDownload(client: AdminClient, id: string, opts: BulkOptions): Promise<Record<string, any>[]> {
  const domain = client.store.domain;
  const wait = opts.wait ?? bulkIO.wait;
  const pollMs = opts.pollMs ?? 2000;
  const stallMs = opts.timeoutMs ?? 30 * 60_000;
  let lastCount = -1;
  let movedAt = Date.now();
  // The operation runs on Shopify's side whatever happens here, so a failed status check or download is
  // tried again a few times instead of giving up on writes that are going through anyway.
  let misses = 0;
  const again = async (e: Error, what: string) => {
    if (++misses > 5) throw new ShopifyError(`${domain}: bulk operation ${id}: ${what} kept failing (${e.message}). It may still finish on Shopify's side.`);
    await wait(Math.min(30_000, pollMs * 2 ** misses));
  };
  let cancelAsked = false;
  for (;;) {
    await wait(pollMs);
    if (opts.signal?.aborted && !cancelAsked) {
      cancelAsked = true;
      await cancelBulkOperations(client, [id]);
    }
    let node: { status: string; errorCode: string | null; objectCount: string; url: string | null; partialDataUrl: string | null } | null;
    try {
      ({ node } = await client.request<{ node: typeof node }>(POLL, { id }));
    } catch (e) {
      await again(e as Error, "checking its status");
      continue;
    }
    if (!node) throw new ShopifyError(`${domain}: bulk operation ${id} disappeared`);
    if (node.status === "COMPLETED") {
      if (!node.url) return [];
      let text: string;
      try {
        text = await (opts.download ?? bulkIO.download)(node.url);
      } catch (e) {
        await again(e as Error, "downloading its results");
        continue;
      }
      return parseJsonl(text);
    }
    misses = 0;
    // A cancelled operation still hands back the results of the lines it had finished.
    if (node.status === "CANCELED" && cancelAsked) {
      if (!node.partialDataUrl) return [];
      return parseJsonl(await (opts.download ?? bulkIO.download)(node.partialDataUrl).catch(() => ""));
    }
    if (node.status === "FAILED" || node.status === "CANCELED" || node.status === "EXPIRED") {
      throw new ShopifyError(`${domain}: bulk operation ${node.status.toLowerCase()}${node.errorCode ? ` (${node.errorCode})` : ""}`);
    }
    opts.onProgress?.(Number(node.objectCount) || 0);
    const count = Number(node.objectCount) || 0;
    if (count !== lastCount) {
      lastCount = count;
      movedAt = Date.now();
    } else if (Date.now() - movedAt > stallMs) {
      throw new ShopifyError(
        `${domain}: bulk operation ${id} has written nothing more for ${Math.round(stallMs / 60_000)} minutes (SYNC_BULK_TIMEOUT_MS); it may still finish on Shopify's side, so plan again before re-applying`,
      );
    }
  }
}

export function parseJsonl(text: string): Record<string, any>[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, any>);
}

const STAGE = /* GraphQL */ `
  mutation StageBulkVariables($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url parameters { name value } }
      userErrors { field message }
    }
  }
`;

const RUN_MUTATION = /* GraphQL */ `
  mutation BulkWrite($mutation: String!, $stagedUploadPath: String!) {
    bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
      bulkOperation { id status }
      userErrors { field message code }
    }
  }
`;

export type Upload = (url: string, form: FormData) => Promise<void>;

const defaultUpload: Upload = async (url, form) => {
  const res = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok) throw new Error(`upload failed with HTTP ${res.status}`);
};

/** Thrown when a bulk write can't start at all, so the caller can fall back to one request per item. */
export class BulkUnavailable extends Error {}

/** How many bulk write operations run at once on one store (Shopify allows 5 from API 2026-01). */
export const bulkParallel = () => envNumber("SYNC_BULK_PARALLEL", 5);

/** `unknown`: Shopify gave no result for this line (its operation was abandoned or cancelled), so it may or may not have been written. */
export type LineResult = { data?: Record<string, any>; errors?: { message: string }[]; unknown?: boolean };

/** Upload one file of variables and start the bulk operation on it. Returns its id. */
async function startMutation(client: AdminClient, mutation: string, lines: Record<string, unknown>[], opts: { upload?: Upload }): Promise<string> {
  const domain = client.store.domain;
  const jsonl = lines.map((l) => JSON.stringify(l)).join("\n");
  const staged = await client.request<{
    stagedUploadsCreate: { stagedTargets: { url: string; parameters: { name: string; value: string }[] }[]; userErrors: { message: string }[] };
  }>(STAGE, { input: [{ resource: "BULK_MUTATION_VARIABLES", filename: "variables.jsonl", mimeType: "text/jsonl", httpMethod: "POST" }] });
  const target = staged.stagedUploadsCreate.stagedTargets[0];
  if (staged.stagedUploadsCreate.userErrors?.length || !target) {
    throw new BulkUnavailable(`${domain}: bulk write could not be prepared: ${staged.stagedUploadsCreate.userErrors.map((e) => e.message).join("; ")}`);
  }
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  // The file has to be the last field of the form.
  form.append("file", new Blob([jsonl], { type: "text/jsonl" }), "variables.jsonl");
  await (opts.upload ?? bulkIO.upload)(target.url, form).catch((e: Error) => {
    throw new BulkUnavailable(`${domain}: bulk write file could not be uploaded: ${e.message}`);
  });
  const path = target.parameters.find((p) => p.name === "key")?.value;
  if (!path) throw new BulkUnavailable(`${domain}: bulk write upload returned no path`);
  const started = await client.request<{
    bulkOperationRunMutation: { bulkOperation: { id: string } | null; userErrors: { message: string; code?: string }[] };
  }>(RUN_MUTATION, { mutation, stagedUploadPath: path });
  const { bulkOperation, userErrors } = started.bulkOperationRunMutation;
  if (userErrors?.length || !bulkOperation) {
    throw new BulkUnavailable(`${domain}: bulk write could not start: ${userErrors.map((e) => e.message).join("; ") || "no operation returned"}`);
  }
  return bulkOperation.id;
}

/**
 * Run the mutation once per entry of `lines` (its variables), as a few bulk operations at once.
 * Returns one result per line, in line order: the mutation's data, or the errors for that line.
 */
export async function bulkMutation(
  client: AdminClient,
  mutation: string,
  lines: Record<string, unknown>[],
  opts: BulkOptions & {
    upload?: Upload;
    /** Called as each part finishes: which part, how many parts, its first line's index, and its results. */
    onPart?: (part: number, parts: number, start: number, results: LineResult[]) => void;
  } = {},
): Promise<LineResult[]> {
  if (!lines.length) return [];
  // Shopify works through one operation's lines one after the other, so big writes are split.
  const parts = Math.max(1, Math.min(bulkParallel(), Math.ceil(lines.length / 100)));
  const size = Math.ceil(lines.length / parts);
  const chunks = Array.from({ length: parts }, (_, i) => ({ start: i * size, lines: lines.slice(i * size, i * size + size) })).filter((c) => c.lines.length);

  const out: LineResult[] = lines.map(() => ({ errors: [{ message: "no result for this line" }], unknown: true }));
  const collect = (start: number, count: number, rows: Record<string, any>[]) => {
    for (const r of rows) {
      const n = Number(r.__lineNumber);
      if (Number.isInteger(n) && n >= 0 && n < count) out[start + n] = { data: r.data ?? undefined, errors: r.errors ?? undefined };
    }
  };
  // Lines written so far, per part, summed for onProgress.
  const written = chunks.map(() => 0);
  const report = () => opts.onProgress?.(written.reduce((a, b) => a + b, 0));
  const fail = (c: (typeof chunks)[number], message: string) =>
    c.lines.forEach((_, k) => (out[c.start + k] = { errors: [{ message: `not written: ${message}` }], unknown: true }));
  const running = new Set<Promise<void>>();
  for (const [n, c] of chunks.entries()) {
    let id: string | undefined;
    while (!id) {
      if (opts.signal?.aborted) {
        c.lines.forEach((_, k) => (out[c.start + k] = { errors: [{ message: "not written: the apply was cancelled" }] }));
        break;
      }
      try {
        id = await startMutation(client, mutation, c.lines, opts);
      } catch (e) {
        if (n === 0 || !(e instanceof BulkUnavailable)) throw e;
        // The store runs fewer at once than asked: wait for one running part to finish, then try again.
        if (running.size && /limit|in progress|already/i.test(e.message)) {
          await Promise.race(running);
          continue;
        }
        // Earlier parts are already writing, so this part is reported as not written rather than retried one by one.
        fail(c, e.message);
        break;
      }
    }
    if (!id) continue;
    opts.onStart?.(id);
    const onProgress = (objects: number) => {
      written[n] = Math.min(objects, c.lines.length);
      report();
    };
    const part: Promise<void> = pollAndDownload(client, id, { ...opts, onProgress })
      .then((rows) => collect(c.start, c.lines.length, rows))
      // One part failing doesn't lose the others: its lines are reported as not written.
      .catch((e: Error) => fail(c, e.message))
      .then(() => {
        if (opts.signal?.aborted) {
          for (let k = c.start; k < c.start + c.lines.length; k++) {
            if (out[k]!.unknown) out[k] = { errors: [{ message: "not written: the apply was cancelled" }], unknown: true };
          }
        }
        onProgress(c.lines.length);
        opts.onPart?.(n + 1, chunks.length, c.start, out.slice(c.start, c.start + c.lines.length));
      })
      .finally(() => running.delete(part));
    running.add(part);
  }
  await Promise.all(running);
  return out;
}
