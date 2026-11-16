import { envNumber, ShopifyError, type AdminClient } from "./client.js";

/** Above this many items a read or write goes through a bulk operation instead of single requests. */
export const bulkThreshold = () => envNumber("SYNC_BULK_THRESHOLD", 250);
/** How long a bulk operation may run. */
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
  const res = await fetch(url);
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
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  for (;;) {
    await wait(pollMs);
    const { node } = await client.request<{
      node: { status: string; errorCode: string | null; objectCount: string; url: string | null; partialDataUrl: string | null } | null;
    }>(POLL, { id });
    if (!node) throw new ShopifyError(`${domain}: bulk operation ${id} disappeared`);
    if (node.status === "COMPLETED") {
      if (!node.url) return [];
      const text = await (opts.download ?? bulkIO.download)(node.url).catch((e: Error) => {
        throw new ShopifyError(`${domain}: bulk operation finished but its file could not be downloaded: ${e.message}`);
      });
      return parseJsonl(text);
    }
    if (node.status === "FAILED" || node.status === "CANCELED" || node.status === "EXPIRED") {
      throw new ShopifyError(`${domain}: bulk operation ${node.status.toLowerCase()}${node.errorCode ? ` (${node.errorCode})` : ""}`);
    }
    opts.onProgress?.(Number(node.objectCount) || 0);
    if (Date.now() > deadline) throw new ShopifyError(`${domain}: bulk operation still running after the time limit (SYNC_BULK_TIMEOUT_MS)`);
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
  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload failed with HTTP ${res.status}`);
};

/** Thrown when a bulk write can't start at all, so the caller can fall back to one request per item. */
export class BulkUnavailable extends Error {}

/** How many bulk write operations run at once on one store (Shopify allows 5 from API 2026-01). */
export const bulkParallel = () => envNumber("SYNC_BULK_PARALLEL", 5);

export type LineResult = { data?: Record<string, any>; errors?: { message: string }[] };

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

  const out: LineResult[] = lines.map(() => ({ errors: [{ message: "no result for this line" }] }));
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
    c.lines.forEach((_, k) => (out[c.start + k] = { errors: [{ message: `not written: ${message}` }] }));
  const running = new Set<Promise<void>>();
  for (const [n, c] of chunks.entries()) {
    let id: string | undefined;
    while (!id) {
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
    const onProgress = (objects: number) => {
      written[n] = Math.min(objects, c.lines.length);
      report();
    };
    const part: Promise<void> = pollAndDownload(client, id, { ...opts, onProgress })
      .then((rows) => collect(c.start, c.lines.length, rows))
      // One part failing doesn't lose the others: its lines are reported as not written.
      .catch((e: Error) => fail(c, e.message))
      .then(() => {
        onProgress(c.lines.length);
        opts.onPart?.(n + 1, chunks.length, c.start, out.slice(c.start, c.start + c.lines.length));
      })
      .finally(() => running.delete(part));
    running.add(part);
  }
  await Promise.all(running);
  return out;
}
