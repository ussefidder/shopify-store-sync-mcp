import { preview, stableStringify, type FieldChange, type ResourceDiff } from "./diff.js";
import type { ItemCheck, Scope } from "./engine.js";
import type { Plan } from "./plan.js";
import type { ThemeDiff } from "./themes.js";

/*
 * Markdown reports of a diff, a plan or a theme comparison, to paste into a ticket, a pull
 * request or an email (`--format md`). Values are shortened to keep tables readable; use
 * --json for the full values.
 */

const MAX = 120;

/** A value as table-cell text: shortened, on one line, with pipes escaped. */
function cell(v: unknown): string {
  if (v === undefined) return "_none_";
  const p = preview(typeof v === "string" ? v : stableStringify(v), MAX);
  const s = typeof p === "string" ? p : JSON.stringify(p);
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|") || "_empty_";
}

/** One line saying what a comparison covered, so a narrow check isn't mistaken for a full one. */
export function scopeLine(kinds: readonly string[], scope: Scope = {}): string {
  const parts: string[] = [kinds.join(", ")];
  const add = (label: string, v?: string[]) => v?.length && parts.push(`${label} ${v.join(", ")}`);
  add("only", scope.include);
  add("except", scope.exclude);
  add("metaobject types", scope.metaobjectTypes);
  add("owner types", scope.ownerTypes);
  add("namespaces", scope.namespaces);
  add("languages", scope.locales);
  if (scope.includeReserved) parts.push("Shopify-reserved definitions included");
  if (parts.length === 1) parts.push("everything in them");
  return parts.join("; ");
}

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
const today = () => new Date().toISOString().slice(0, 10);

function changesTable(rows: { item: string; change: FieldChange }[], sourceLabel: string, targetLabel: string): string[] {
  if (!rows.length) return [];
  return [
    `| Item | Field | ${targetLabel} (now) | ${sourceLabel} (source) |`,
    "|---|---|---|---|",
    ...rows.map(({ item, change }) => `| ${code(item)} | ${code(change.path)} | ${cell(change.target)} | ${cell(change.source)} |`),
  ];
}

type Store = { alias: string; domain: string };
type Skipped = { kind: string; key: string; reason: string }[];

function notCompared(skipped: Skipped): string[] {
  const unreadable = skipped.filter((x) => x.key.includes("*"));
  if (!unreadable.length) return [];
  return ["", "## Not compared", "", ...unreadable.map((x) => `- ${x.kind} ${code(x.key)}: ${x.reason}`)];
}

export function diffMarkdown(source: Store, target: Store, diffs: ResourceDiff[], skipped: Skipped = [], scope?: Scope): string {
  const lines = [
    `# Store diff: ${source.alias} → ${target.alias}`,
    "",
    `Source of truth: **${source.alias}** (${source.domain}). Compared with: **${target.alias}** (${target.domain}). ${today()}, shopify-store-sync-mcp.`,
    "",
    `Compared: ${scopeLine(diffs.map((d) => d.kind), scope)}.`,
    "",
    `| Resource | Only in ${source.alias} | Changed | Only in ${target.alias} | Identical |`,
    "|---|---:|---:|---:|---:|",
    ...diffs.map((d) => `| ${d.kind} | ${d.onlyInSource.length} | ${d.changed.length} | ${d.onlyInTarget.length} | ${d.identical} |`),
  ];
  for (const d of diffs) {
    if (!d.onlyInSource.length && !d.changed.length && !d.onlyInTarget.length) continue;
    lines.push("", `## ${d.kind}`);
    if (d.onlyInSource.length) lines.push("", `**Only in ${source.alias}** (${d.onlyInSource.length})`, "", ...d.onlyInSource.map((i) => `- ${code(i.key)}`));
    if (d.changed.length) {
      lines.push("", `**Changed** (${d.changed.length})`, "");
      lines.push(...changesTable(d.changed.flatMap((c) => c.changes.map((change) => ({ item: c.key, change }))), source.alias, target.alias));
    }
    if (d.onlyInTarget.length) {
      lines.push("", `**Only in ${target.alias}** (${d.onlyInTarget.length}, kept: this tool never deletes)`, "", ...d.onlyInTarget.map((i) => `- ${code(i.key)}`));
    }
  }
  lines.push(...notCompared(skipped));
  return lines.join("\n") + "\n";
}

export function planMarkdown(plan: Plan): string {
  const count = (a: string) => plan.ops.filter((o) => o.action === a).length;
  const lines = [
    `# Sync plan ${code(plan.id)}: ${plan.source.alias} → ${plan.target.alias}`,
    "",
    `Makes **${plan.target.alias}** (${plan.target.domain}) match **${plan.source.alias}** (${plan.source.domain}). Created ${plan.createdAt.slice(0, 16).replace("T", " ")} UTC. Nothing has been written yet.`,
    "",
    `**${count("create")}** to create · **${count("update")}** to update · **${count("conflict")}** conflict${count("conflict") === 1 ? "" : "s"}`,
  ];
  if (plan.ops.length) {
    lines.push("", "| # | Action | Resource | Item | Details |", "|---:|---|---|---|---|");
    for (const o of plan.ops) {
      const details = o.reason ? o.reason : o.changes?.length ? o.changes.map((c) => c.path).join(", ") : "";
      lines.push(`| ${o.seq} | ${o.action} | ${o.kind} | ${code(o.key)} | ${details.replace(/\|/g, "\\|")} |`);
    }
    const updates = plan.ops.filter((o) => o.action === "update" && o.changes?.length);
    if (updates.length) {
      lines.push("", "## Changes", "");
      lines.push(...changesTable(updates.flatMap((o) => o.changes!.map((change) => ({ item: o.key, change }))), plan.source.alias, plan.target.alias));
    }
  }
  if (plan.warnings.length) lines.push("", "## Warnings", "", ...plan.warnings.map((w) => `- ${w}`));
  const kept = plan.onlyInTarget.filter((x) => x.keys.length);
  if (kept.length) lines.push("", `## Only in ${plan.target.alias} (kept)`, "", ...kept.map((x) => `- ${x.kind}: ${x.keys.length}`));
  lines.push(...notCompared(plan.skipped));
  return lines.join("\n") + "\n";
}

export function themesMarkdown(source: string, target: string, d: ThemeDiff): string {
  const lines = [
    `# Theme diff: ${source} → ${target}`,
    "",
    `**${d.source.name}** on ${source} compared with **${d.target.name}** on ${target}. ${today()}, read-only.`,
    "",
    `${d.onlyInSource.length} only in ${source} · ${d.changed.length} changed · ${d.onlyInTarget.length} only in ${target} · ${d.identical} identical${d.ignored ? ` · ${d.ignored} setting difference(s) ignored on purpose` : ""}`,
  ];
  if (d.onlyInSource.length) lines.push("", `## Only in ${source}`, "", ...d.onlyInSource.map((f) => `- ${code(f)}`));
  if (d.changed.length) {
    lines.push("", "## Changed settings", "");
    lines.push(...changesTable(d.changed.flatMap((f) => f.changes.map((change) => ({ item: f.file, change }))), source, target));
  }
  if (d.onlyInTarget.length) lines.push("", `## Only in ${target}`, "", ...d.onlyInTarget.map((f) => `- ${code(f)}`));
  if (d.unreadable.length) lines.push("", "## Not readable as JSON", "", ...d.unreadable.map((f) => `- ${code(f)}`));
  return lines.join("\n") + "\n";
}

export function checkMarkdown(c: ItemCheck): string {
  const lines = [
    `# ${c.kind} ${code(c.key)}: ${c.source} → ${c.target}`,
    "",
    `**${c.status}**${c.changes.length ? ` (${c.changes.length} field${c.changes.length === 1 ? "" : "s"})` : ""}. ${today()}, shopify-store-sync-mcp.`,
  ];
  if (c.changes.length) lines.push("", ...changesTable(c.changes.map((change) => ({ item: c.key, change })), c.source, c.target));
  if (c.refs.length) {
    lines.push("", `## Points at (${c.refs.length})`, "");
    for (const r of c.refs) lines.push(`- ${code(r.ref)}: ${r.inTarget === true ? `in ${c.target}` : r.inTarget === false ? `**missing in ${c.target}**` : r.inTarget}`);
  }
  lines.push(...notCompared(c.notCompared));
  return lines.join("\n") + "\n";
}
