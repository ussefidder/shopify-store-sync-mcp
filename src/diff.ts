import { createHash } from "node:crypto";
import { collectRefs, UNRESOLVED_PREFIX } from "./refs.js";
import type { Item, ResourceKind } from "./resources/index.js";

export interface FieldChange {
  path: string;
  source: unknown;
  target: unknown;
}

export interface ChangedItem {
  key: string;
  source: Item;
  target: Item;
  changes: FieldChange[];
}

export interface ResourceDiff {
  kind: ResourceKind;
  onlyInSource: Item[];
  onlyInTarget: Item[];
  changed: ChangedItem[];
  identical: number;
}

export interface KeyFilter {
  /** Glob patterns (only * is special). An item is kept if it matches any. Default: everything. */
  include?: string[];
  /** Glob patterns. Matching items are dropped. */
  exclude?: string[];
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function matchesFilter(key: string, filter: KeyFilter = {}): boolean {
  if (filter.include?.length && !filter.include.some((g) => globToRegExp(g).test(key))) return false;
  if (filter.exclude?.some((g) => globToRegExp(g).test(key))) return false;
  return true;
}

/** Deterministic JSON (sorted object keys) so hashes and equality don't depend on key order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashData(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Arrays of objects that all carry a string `key` are matched by key, not by position. */
function keyedArray(v: unknown[]): Map<string, unknown> | undefined {
  if (!v.every((x) => isObj(x) && typeof x.key === "string")) return undefined;
  return new Map(v.map((x) => [(x as { key: string }).key, x]));
}

/**
 * True for values that only hold refs we can't map across stores (files, variants...).
 * They can't be synced, so they must not show up as a permanent difference.
 */
export function isUnsyncable(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const refs = [...collectRefs(value)];
  return refs.length > 0 && refs.every((r) => r.startsWith(UNRESOLVED_PREFIX));
}

/** Field-level differences, reported from the source's point of view (source = desired value). */
export function diffValues(source: unknown, target: unknown, path = ""): FieldChange[] {
  if (stableStringify(source) === stableStringify(target)) return [];
  if (isUnsyncable(source)) return [];

  if (isObj(source) && isObj(target)) {
    const keys = [...new Set([...Object.keys(source), ...Object.keys(target)])].sort();
    return keys.flatMap((k) => diffValues(source[k], target[k], path ? `${path}.${k}` : k));
  }

  if (Array.isArray(source) && Array.isArray(target)) {
    const s = keyedArray(source);
    const t = keyedArray(target);
    if (s && t) {
      const keys = [...new Set([...s.keys(), ...t.keys()])];
      return keys.flatMap((k) => diffValues(s.get(k), t.get(k), `${path}[${k}]`));
    }
    if (source.length === target.length) {
      return source.flatMap((v, i) => diffValues(v, target[i], `${path}[${i}]`));
    }
  }

  return [{ path: path || "(root)", source, target }];
}

export function diffItems(kind: ResourceKind, source: Item[], target: Item[], filter: KeyFilter = {}): ResourceDiff {
  const src = new Map(source.filter((i) => matchesFilter(i.key, filter)).map((i) => [i.key, i]));
  const tgt = new Map(target.filter((i) => matchesFilter(i.key, filter)).map((i) => [i.key, i]));

  const result: ResourceDiff = { kind, onlyInSource: [], onlyInTarget: [], changed: [], identical: 0 };
  for (const [key, s] of src) {
    const t = tgt.get(key);
    if (!t) {
      result.onlyInSource.push(s);
      continue;
    }
    const changes = diffValues(s.data, t.data);
    if (changes.length) result.changed.push({ key, source: s, target: t, changes });
    else result.identical++;
  }
  for (const [key, t] of tgt) if (!src.has(key)) result.onlyInTarget.push(t);

  const byKey = (a: { key: string }, b: { key: string }) => a.key.localeCompare(b.key);
  result.onlyInSource.sort(byKey);
  result.onlyInTarget.sort(byKey);
  result.changed.sort(byKey);
  return result;
}

/** Shorten long values (page bodies, rich text) for display. */
export function preview(value: unknown, max = 160): unknown {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}… (${value.length} chars)` : value;
  const s = stableStringify(value);
  return s && s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : value;
}
