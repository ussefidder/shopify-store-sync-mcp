import { ApplyRefused } from "./apply.js";
import { loadStores, StoreRegistry } from "./config.js";
import { preview, type ResourceDiff } from "./diff.js";
import { Engine, type Scope } from "./engine.js";
import type { Plan } from "./plan.js";
import { RESOURCE_KINDS, type ResourceKind } from "./resources/index.js";
import { summarizeDiff, summarizePlan, summarizeThemes } from "./server.js";

export const COMMANDS = ["stores", "diff", "plan", "plans", "apply", "export", "themes", "help"] as const;

const HELP = `shopify-store-sync: diff and sync configuration between Shopify stores

Usage
  shopify-store-sync-mcp                          start the MCP server (stdio)
  shopify-store-sync-mcp stores                   list configured stores
  shopify-store-sync-mcp diff   <source> <target> compare (read-only)
  shopify-store-sync-mcp plan   <source> <target> dry-run plan, prints a plan id
  shopify-store-sync-mcp apply  <plan-id>         apply a plan
  shopify-store-sync-mcp plans                    list recent plans
  shopify-store-sync-mcp export <store> <dir>     write a store's config to files (for git)
  shopify-store-sync-mcp themes <source> <target> compare theme settings (read-only)

<source> and <target> are store aliases; diff and plan also accept dir:<path> for a snapshot folder.

Options
  --resources a,b        ${RESOURCE_KINDS.join(", ")}
  --include  glob,glob   only keys matching, e.g. "PRODUCT.custom.*,faq/*"
  --exclude  glob,glob   drop keys matching
  --namespaces a,b       metafield value namespaces      --locales fr,de   translation locales
  --confirm <domain>     required to apply to a protected store
  --only 1,2,3           apply only these plan steps
  --files a,b            theme file patterns              --source-theme / --target-theme <id>
  --exit-code            diff/themes: exit 2 when differences are found
  --json                 machine-readable output`;

type Flags = Record<string, string | true>;

export function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
      const next = argv[i + 1];
      if (inline !== undefined) flags[name] = inline;
      else if (next !== undefined && !next.startsWith("--") && !["json", "exit-code", "values"].includes(name)) flags[name] = argv[++i]!;
      else flags[name] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const list = (v: string | true | undefined) => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

export function scopeFromFlags(flags: Flags): Scope {
  const resources = list(flags.resources);
  for (const r of resources ?? []) {
    if (!(RESOURCE_KINDS as readonly string[]).includes(r)) throw new Error(`unknown resource "${r}" (use: ${RESOURCE_KINDS.join(", ")})`);
  }
  return {
    resources: resources as ResourceKind[] | undefined,
    include: list(flags.include),
    exclude: list(flags.exclude),
    namespaces: list(flags.namespaces),
    locales: list(flags.locales),
    metaobjectTypes: list(flags["metaobject-types"]),
    ownerTypes: list(flags["owner-types"]),
  };
}

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = c("32"), yellow = c("33"), red = c("31"), blue = c("36"), dim = c("2"), bold = c("1");

function printDiff(diffs: ResourceDiff[], values: boolean) {
  for (const d of diffs) {
    const n = d.onlyInSource.length + d.changed.length + d.onlyInTarget.length;
    console.log(`${bold(d.kind.padEnd(24))} ${green(`+${d.onlyInSource.length}`)} ${yellow(`~${d.changed.length}`)} ${blue(`only in target ${d.onlyInTarget.length}`)} ${dim(`= ${d.identical}`)}`);
    if (!n) continue;
    for (const i of d.onlyInSource) console.log(`  ${green("+")} ${i.key}`);
    for (const ch of d.changed) {
      console.log(`  ${yellow("~")} ${ch.key} ${dim(ch.changes.map((x) => x.path).join(", "))}`);
      if (values) for (const x of ch.changes) console.log(`      ${dim(x.path)}  ${red(String(preview(x.target, 80)))}  ->  ${green(String(preview(x.source, 80)))}`);
    }
    for (const i of d.onlyInTarget) console.log(`  ${blue("·")} ${i.key} ${dim("(only in target, never deleted)")}`);
  }
}

function printPlan(plan: Plan) {
  const s = summarizePlan(plan, true);
  console.log(`${bold("Plan")} ${plan.id}  ${plan.source.alias} -> ${plan.target.alias} (${plan.target.domain})`);
  console.log(`${green(`${s.totals.create} create`)} · ${yellow(`${s.totals.update} update`)} · ${red(`${s.totals.conflict} conflict`)}${s.filesToUpload ? ` · ${blue(`${s.filesToUpload} file upload`)}` : ""}\n`);
  for (const o of s.ops) {
    const sym = o.action === "create" ? green("+") : o.action === "update" ? yellow("~") : red("!");
    const extra = o.reason ? red(o.reason) : o.changes?.length ? dim(o.changes.map((x) => x.path).join(", ")) : "";
    console.log(`${String(o.seq).padStart(4)} ${sym} ${o.kind.padEnd(22)} ${o.key} ${extra}`);
  }
  for (const w of plan.warnings) console.log(yellow(`\n! ${w}`));
  console.log(dim(`\nNothing written yet. Apply with: shopify-store-sync-mcp apply ${plan.id}`));
}

export async function runCli(argv: string[], env: NodeJS.ProcessEnv = process.env, injected?: Engine): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [cmd, a, b] = positional;
  const asJson = flags.json === true;
  const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));

  if (!cmd || cmd === "help") {
    console.log(HELP);
    return 0;
  }
  const engine = injected ?? new Engine(new StoreRegistry(loadStores(env)));
  const need = (...vals: (string | undefined)[]) => {
    if (vals.some((v) => !v)) throw new Error(`missing arguments; run "shopify-store-sync-mcp help"`);
  };

  try {
    switch (cmd) {
      case "stores": {
        const stores = engine.registry.list().map((s) => ({ alias: s.alias, domain: s.domain, writes: s.allowWrites, protected: s.protected }));
        if (asJson) out(stores);
        else if (!stores.length) console.log("No stores configured. See the README, Configuration.");
        else for (const s of stores) console.log(`${bold(s.alias.padEnd(12))} ${s.domain}  ${s.writes ? green("writes on") : dim("read-only")}${s.protected ? red("  protected") : ""}`);
        return 0;
      }
      case "diff": {
        need(a, b);
        const { diffs } = await engine.compare(a!, b!, scopeFromFlags(flags));
        if (asJson) out(diffs.map((d) => summarizeDiff(d, true, 1000)));
        else printDiff(diffs, flags.values === true);
        const changed = diffs.some((d) => d.onlyInSource.length || d.changed.length);
        return flags["exit-code"] && changed ? 2 : 0;
      }
      case "plan": {
        need(a, b);
        const plan = await engine.plan(a!, b!, scopeFromFlags(flags));
        if (asJson) out(summarizePlan(plan, true));
        else printPlan(plan);
        return 0;
      }
      case "plans": {
        const plans = engine.plans.list().sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 20);
        if (asJson) out(plans.map((p) => ({ id: p.id, createdAt: p.createdAt, status: p.status, source: p.source.alias, target: p.target.alias, ops: p.ops.length })));
        else for (const p of plans) console.log(`${p.id}  ${p.createdAt.slice(0, 16)}  ${p.status.padEnd(17)} ${p.source.alias} -> ${p.target.alias}  ${p.ops.length} steps`);
        return 0;
      }
      case "apply": {
        need(a);
        const only = list(flags.only)?.map(Number);
        const { plan, results } = await engine.apply(a!, { confirm: typeof flags.confirm === "string" ? flags.confirm : undefined, only });
        if (asJson) out({ status: plan.status, results });
        else {
          for (const r of results) {
            const mark = r.outcome === "failed" ? red("✗") : r.outcome === "skipped" ? dim("-") : green("✓");
            console.log(`${mark} ${r.outcome.padEnd(8)} ${r.kind.padEnd(22)} ${r.key}${r.message ? dim(`  ${r.message}`) : ""}`);
          }
          console.log(`\n${bold(plan.status)}`);
        }
        return results.some((r) => r.outcome === "failed") ? 1 : 0;
      }
      case "export": {
        need(a, b);
        const res = await engine.export(a!, b!, scopeFromFlags(flags));
        if (asJson) out(res);
        else {
          for (const k of res.kinds) console.log(`${k.kind.padEnd(24)} ${k.items} item${k.items === 1 ? "" : "s"}`);
          console.log(green(`\nWrote ${res.files} files to ${res.dir}`));
        }
        return 0;
      }
      case "themes": {
        need(a, b);
        const d = await engine.themes(a!, b!, {
          sourceTheme: typeof flags["source-theme"] === "string" ? flags["source-theme"] : undefined,
          targetTheme: typeof flags["target-theme"] === "string" ? flags["target-theme"] : undefined,
          files: list(flags.files),
        });
        if (asJson) out(summarizeThemes(d));
        else {
          console.log(`${bold("Themes")} ${d.source.name} (${a}) vs ${d.target.name} (${b})`);
          for (const f of d.onlyInSource) console.log(`  ${green("+")} ${f}`);
          for (const f of d.changed) console.log(`  ${yellow("~")} ${f.file} ${dim(`${f.changes.length} setting(s): ${f.changes.slice(0, 5).map((x) => x.path).join(", ")}${f.changes.length > 5 ? "…" : ""}`)}`);
          for (const f of d.onlyInTarget) console.log(`  ${blue("·")} ${f} ${dim("(only in target)")}`);
          console.log(dim(`\n${d.identical} identical`));
        }
        return flags["exit-code"] && (d.changed.length || d.onlyInSource.length) ? 2 : 0;
      }
      default:
        console.error(`unknown command "${cmd}"\n\n${HELP}`);
        return 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(red(err instanceof ApplyRefused ? `Refused: ${msg}` : msg));
    return 1;
  }
}
