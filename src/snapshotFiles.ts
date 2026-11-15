import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stableStringify } from "./diff.js";
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

export function readSnapshot(dir: string, kinds?: readonly ResourceKind[]): Snapshot {
  const root = resolve(dir);
  const manifestPath = join(root, MANIFEST);
  if (!existsSync(manifestPath)) throw new Error(`${root} has no ${MANIFEST}; export a snapshot there first`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""));
  if (manifest.format !== SNAPSHOT_FORMAT) throw new Error(`${manifestPath}: unsupported format ${String(manifest.format)}`);

  const resources: Snapshot["resources"] = {};
  for (const kind of manifest.resources as ResourceKind[]) {
    if (kinds && !kinds.includes(kind)) continue;
    const folder = join(root, kind);
    const items: Item[] = existsSync(folder)
      ? readdirSync(folder)
          .filter((f) => f.endsWith(".json"))
          .map((f) => {
            const { key, data } = JSON.parse(readFileSync(join(folder, f), "utf8").replace(/^\uFEFF/, ""));
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
