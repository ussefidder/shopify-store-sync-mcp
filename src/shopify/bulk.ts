import { ShopifyError, type AdminClient } from "./client.js";

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

  const wait = opts.wait ?? sleep;
  const pollMs = opts.pollMs ?? 2000;
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  for (;;) {
    await wait(pollMs);
    const { node } = await client.request<{
      node: { status: string; errorCode: string | null; objectCount: string; url: string | null; partialDataUrl: string | null } | null;
    }>(POLL, { id: bulkOperation.id });
    if (!node) throw new ShopifyError(`${domain}: bulk read ${bulkOperation.id} disappeared`);
    if (node.status === "COMPLETED") {
      if (!node.url) return [];
      const text = await (opts.download ?? defaultDownload)(node.url).catch((e: Error) => {
        throw new ShopifyError(`${domain}: bulk read finished but its file could not be downloaded: ${e.message}`);
      });
      return parseJsonl(text);
    }
    if (node.status === "FAILED" || node.status === "CANCELED" || node.status === "EXPIRED") {
      throw new ShopifyError(`${domain}: bulk read ${node.status.toLowerCase()}${node.errorCode ? ` (${node.errorCode})` : ""}`);
    }
    opts.onProgress?.(Number(node.objectCount) || 0);
    if (Date.now() > deadline) throw new ShopifyError(`${domain}: bulk read still running after the time limit (SYNC_BULK_TIMEOUT_MS)`);
  }
}

export function parseJsonl(text: string): Record<string, any>[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, any>);
}
