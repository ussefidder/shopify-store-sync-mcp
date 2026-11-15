import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { stableStringify } from "./diff.js";
import { isShopifyFileUrl } from "./refs.js";
import { RESOURCE_KINDS, type Item, type ResourceKind } from "./resources/index.js";
import type { Snapshot } from "./snapshot.js";

/*
 * Store configuration as code. A snapshot is written as one small JSON file per item, with
 * sorted keys and no store-specific IDs, so it can live in git, be reviewed in a pull request,
 * and be used as the source of a sync ("dir:./config/prod").
 *
 *   <dir>/snapshot.json                  store, time, resource kinds, file download URLs
 *   <dir>/<kind>/<item>.json             { "key": ..., "data": ... }
 */

export const SNAPSHOT_FORMAT = "shopify-store-sync/1";
const MANIFEST = "snapshot.json";

/** Pretty JSON with sorted keys, so files diff cleanly in git. */
function pretty(value: unknown): string {
  return `${JSON.stringify(JSON.parse(stableStringify(value)), null, 2)}\n`;
}

export function itemFilename(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 120) || "item";
  return safe;
}

export interface ExportResult {
  dir: string;
  files: number;
  kinds: { kind: ResourceKind; items: number }[];
}

export function exportSnapshot(snapshot: Snapshot, dir: string): ExportResult {
  const root = resolve(dir);
  if (existsSync(root)) {
    if (!statSync(root).isDirectory()) throw new Error(`${root} is not a folder`);
    const entries = readdirSync(root).filter((f) => !f.startsWith("."));
    if (entries.length && !entries.includes(MANIFEST)) {
      throw new Error(`${root} is not empty and is not a snapshot folder; choose an empty or new folder`);
    }
  }
  mkdirSync(root, { recursive: true });

  const kinds = RESOURCE_KINDS.filter((k) => snapshot.resources[k]);
  let files = 0;
  const summary: ExportResult["kinds"] = [];
  for (const kind of kinds) {
    const folder = join(root, kind);
    // Replace the folder's items so things removed from the store disappear from the snapshot too.
    if (existsSync(folder)) for (const f of readdirSync(folder)) if (f.endsWith(".json")) rmSync(join(folder, f));
    mkdirSync(folder, { recursive: true });
    const used = new Set<string>();
    const items = [...snapshot.resources[kind]!.items].sort((a, b) => a.key.localeCompare(b.key));
    for (const item of items) {
      let name = itemFilename(item.key);
      if (used.has(name)) name = `${name}-${createHash("sha256").update(item.key).digest("hex").slice(0, 8)}`;
      used.add(name);
      writeFileSync(join(folder, `${name}.json`), pretty({ key: item.key, data: item.data }));
      files++;
    }
    summary.push({ kind, items: items.length });
  }

  writeFileSync(
    join(root, MANIFEST),
    pretty({
      format: SNAPSHOT_FORMAT,
      store: snapshot.store,
      domain: snapshot.domain,
      takenAt: snapshot.takenAt,
      resources: kinds,
      skipped: Object.fromEntries(kinds.map((k) => [k, snapshot.resources[k]!.skipped])),
      files: snapshot.files,
    }),
  );
  return { dir: root, files, kinds: summary };
}

/*
 * A snapshot folder is input like any other: it can come from a pull request or a download.
 * Everything read from it is checked, resource folders can only be the known kinds (so a
 * manifest can't point outside the folder), and file URLs must be on a Shopify file host.
 */
const skippedSchema = z.array(z.object({ key: z.string(), reason: z.string() }));
const manifestSchema = z.object({
  format: z.literal(SNAPSHOT_FORMAT),
  store: z.string().optional(),
  domain: z.string(),
  takenAt: z.string(),
  resources: z.array(z.enum(RESOURCE_KINDS)),
  skipped: z.record(z.string(), skippedSchema).optional(),
  files: z
    .record(
      z.string(),
      z.object({
        url: z.string().refine(isShopifyFileUrl, "file URLs must be https URLs on cdn.shopify.com or a myshopify.com domain"),
        alt: z.string().optional(),
        contentType: z.enum(["IMAGE", "FILE", "VIDEO"]),
      }),
    )
    .optional(),
});
const itemSchema = z.object({ key: z.string().min(1), data: z.record(z.string(), z.unknown()) });

function readJson<T>(file: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${file}: ${issue?.path.length ? `${issue.path.join(".")}: ` : ""}${issue?.message ?? "not a snapshot file"}`);
  }
  return parsed.data;
}

export function readSnapshot(dir: string, kinds?: readonly ResourceKind[]): Snapshot {
  const root = resolve(dir);
  const manifestPath = join(root, MANIFEST);
  if (!existsSync(manifestPath)) throw new Error(`${root} has no ${MANIFEST}; export a snapshot there first`);
  const manifest = readJson(manifestPath, manifestSchema);

  const resources: Snapshot["resources"] = {};
  for (const kind of manifest.resources) {
    if (kinds && !kinds.includes(kind)) continue;
    const folder = join(root, kind);
    const items: Item[] = existsSync(folder)
      ? readdirSync(folder)
          .filter((f) => f.endsWith(".json"))
          .map((f) => {
            const { key, data } = readJson(join(folder, f), itemSchema);
            return { key, id: "", data };
          })
      : [];
    resources[kind] = { items, skipped: manifest.skipped?.[kind] ?? [] };
  }
  return {
    store: `dir:${dir}`,
    domain: manifest.domain,
    takenAt: manifest.takenAt,
    resources,
    files: manifest.files ?? {},
  };
}
