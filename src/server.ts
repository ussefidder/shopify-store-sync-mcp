import { readFileSync } from "node:fs";
import { isAbsolute, parse as parsePath, relative, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApplyRefused } from "./apply.js";
import type { StoreConfig, StoreRegistry } from "./config.js";
import { preview, type ResourceDiff } from "./diff.js";
import { DIR_PREFIX, Engine, isDirSpec, type Scope } from "./engine.js";
import { PlanStore, type Plan } from "./plan.js";
import { ADAPTERS, DEFAULT_KINDS, RESOURCE_KINDS, type ResourceKind } from "./resources/index.js";
import { DEFAULT_OWNER_TYPES } from "./resources/metafieldDefinitions.js";
import type { AdminClient } from "./shopify/client.js";
import { DEFAULT_THEME_FILES, type ThemeDiff } from "./themes.js";

/** Read from package.json, so there is one place to bump. */
export const VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

export interface ServerDeps {
  registry: StoreRegistry;
  plans?: PlanStore;
  clientFactory?: (store: StoreConfig) => AdminClient;
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to the working directory. */
  cwd?: string;
}

/**
 * Over MCP, folder arguments come from the assistant, so they are kept inside one base folder:
 * SYNC_SNAPSHOT_DIR when set, otherwise the folder the server was started in. The command line,
 * run by a person, has no such limit.
 */
export function snapshotBase(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return resolve(cwd, env.SYNC_SNAPSHOT_DIR || ".");
}

export function resolveInBase(dir: string, base: string): string {
  if (parsePath(base).root === base) {
    throw new Error("snapshot folders are limited to one base folder, and the server was started in the filesystem root. Set SYNC_SNAPSHOT_DIR to the folder that holds your snapshots.");
  }
  const full = resolve(base, dir);
  const rel = relative(base, full);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`"${dir}" is outside the snapshot base folder (${base}). Use a path inside it, or set SYNC_SNAPSHOT_DIR.`);
  }
  return full;
}

const SOURCE_HELP = 'Store alias, or "dir:<path>" for a snapshot folder made with export_snapshot.';

const scopeArgs = {
  resources: z
    .array(z.enum(RESOURCE_KINDS))
    .min(1)
    .optional()
    .describe(`Resource types to include. Default: ${DEFAULT_KINDS.join(", ")}. products, metafields and translations are opt-in.`),
  owner_types: z
    .array(z.string())
    .optional()
    .describe(
      `Metafield owner types. For metafield_definitions, default: ${DEFAULT_OWNER_TYPES.join(", ")}. For metafield values (metafields): PRODUCT, COLLECTION, PRODUCTVARIANT, SHOP (all by default).`,
    ),
  metaobject_types: z.array(z.string()).optional().describe("Limit metaobjects to these types. Default: all non-reserved types."),
  namespaces: z.array(z.string()).optional().describe("Limit metafield values (metafields) to these namespaces."),
  locales: z.array(z.string()).optional().describe("Limit translations to these locales, e.g. [\"fr\", \"de\"]. Default: every non-primary locale."),
  prices: z.boolean().optional().describe("products: also copy variant prices and compare-at prices. Off by default, since prices usually differ per store."),
  as_drafts: z
    .boolean()
    .optional()
    .describe("Leave the published state alone: new pages are created hidden and new metaobject entries as drafts, existing ones keep their state. Products are always created as drafts."),
  include: z
    .array(z.string())
    .optional()
    .describe('Only keys matching one of these globs, e.g. ["PRODUCT.custom.*", "faq/*", "fr:*"].'),
  exclude: z.array(z.string()).optional().describe("Drop keys matching any of these globs."),
};

type ScopeArgs = {
  resources?: ResourceKind[];
  owner_types?: string[];
  metaobject_types?: string[];
  namespaces?: string[];
  locales?: string[];
  prices?: boolean;
  as_drafts?: boolean;
  include?: string[];
  exclude?: string[];
};

const toScope = (a: ScopeArgs): Scope => ({
  resources: a.resources,
  ownerTypes: a.owner_types,
  metaobjectTypes: a.metaobject_types,
  namespaces: a.namespaces,
  locales: a.locales,
  prices: a.prices,
  drafts: a.as_drafts,
  include: a.include,
  exclude: a.exclude,
});

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

function describeStore(s: StoreConfig) {
  return {
    alias: s.alias,
    domain: s.domain,
    label: s.label,
    apiVersion: s.apiVersion,
    auth: s.auth === "shopify-cli" ? "shopify_cli" : s.accessToken ? "access_token" : "client_credentials",
    allowWrites: s.allowWrites,
    protected: s.protected,
  };
}

export function summarizeDiff(d: ResourceDiff, showValues: boolean, limit: number) {
  return {
    kind: d.kind,
    counts: {
      onlyInSource: d.onlyInSource.length,
      changed: d.changed.length,
      onlyInTarget: d.onlyInTarget.length,
      identical: d.identical,
    },
    onlyInSource: d.onlyInSource.slice(0, limit).map((i) => i.key),
    changed: d.changed.slice(0, limit).map((c) => ({
      key: c.key,
      changes: c.changes.map((ch) => (showValues ? { path: ch.path, source: preview(ch.source), target: preview(ch.target) } : ch.path)),
    })),
    onlyInTarget: d.onlyInTarget.slice(0, limit).map((i) => i.key),
    truncated: Math.max(d.onlyInSource.length, d.changed.length, d.onlyInTarget.length) > limit || undefined,
  };
}

export function summarizePlan(plan: Plan, full = false) {
  const count = (a: string) => plan.ops.filter((o) => o.action === a).length;
  const limit = full ? Number.POSITIVE_INFINITY : 200;
  return {
    plan_id: plan.id,
    status: plan.status,
    source: plan.source,
    target: plan.target,
    expiresAt: plan.expiresAt,
    totals: { create: count("create"), update: count("update"), conflict: count("conflict") },
    warnings: plan.warnings,
    filesToUpload: Object.keys(plan.files ?? {}).length || undefined,
    ops: plan.ops.slice(0, limit).map((o) => ({
      seq: o.seq,
      kind: o.kind,
      key: o.key,
      action: o.action,
      reason: o.reason,
      missingRefs: o.missingRefs,
      changes: o.changes?.map((c) => ({ path: c.path, from: preview(c.target), to: preview(c.source) })),
    })),
    opsTruncated: plan.ops.length > limit ? plan.ops.length - limit : undefined,
    onlyInTarget: plan.onlyInTarget.map((x) => ({ kind: x.kind, count: x.keys.length, keys: x.keys.slice(0, 50) })),
    skipped: plan.skipped.length ? plan.skipped : undefined,
    note: "Nothing has been written. Review, then call apply_plan with this plan_id. Items only in the target are never deleted, and menu links, product tags, variants and media that only the target has are kept.",
  };
}

export function summarizeThemes(d: ThemeDiff, limit = 100) {
  return {
    source: d.source,
    target: d.target,
    counts: { onlyInSource: d.onlyInSource.length, changed: d.changed.length, onlyInTarget: d.onlyInTarget.length, identical: d.identical },
    onlyInSource: d.onlyInSource,
    onlyInTarget: d.onlyInTarget,
    changed: d.changed.map((f) => ({
      file: f.file,
      changes: f.changes.slice(0, limit).map((c) => ({ path: c.path, source: preview(c.source), target: preview(c.target) })),
      more: f.changes.length > limit ? f.changes.length - limit : undefined,
    })),
    unreadable: d.unreadable.length ? d.unreadable : undefined,
    note: "Read-only comparison. This server never writes to themes.",
  };
}

/** What a tool handler gets besides its arguments (the part of the SDK's "extra" used here). */
interface ToolExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void>;
}

/**
 * Progress for long calls. Only sent when the client asked for it (a progress token on the request);
 * clients can use it to keep the call alive instead of giving up at their timeout.
 */
function progressOf(extra: ToolExtra | undefined) {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (token === undefined || !send) return undefined;
  let last = 0;
  return (message: string, done?: number, total?: number) => {
    last = done ?? last + 1;
    void send({ method: "notifications/progress", params: { progressToken: token, progress: last, total, message } }).catch(() => undefined);
  };
}

export function createServer(deps: ServerDeps): McpServer {
  const engine = new Engine(deps.registry, deps.plans ?? new PlanStore(), deps.clientFactory);
  const env = deps.env ?? process.env;
  const base = () => snapshotBase(env, deps.cwd);
  /** A store alias is passed through; a "dir:<path>" is pinned inside the snapshot base folder. */
  const spec = (s: string) => (isDirSpec(s) ? `${DIR_PREFIX}${resolveInBase(s.slice(DIR_PREFIX.length), base())}` : s);

  const guard =
    <A>(fn: (args: A, extra?: ToolExtra) => Promise<ReturnType<typeof json>>) =>
    async (args: A, extra?: unknown) => {
      try {
        return await fn(args, extra as ToolExtra | undefined);
      } catch (err) {
        if (err instanceof ApplyRefused) return fail(`Refused: ${err.message}`);
        return fail(err instanceof Error ? err.message : String(err));
      }
    };
  const reading = (extra: ToolExtra | undefined) => {
    const report = progressOf(extra);
    return report ? (store: string, kind: ResourceKind, items: number) => report(`read ${items} ${kind} from ${store}`) : undefined;
  };

  const server = new McpServer({ name: "shopify-store-sync-mcp", version: VERSION });

  /**
   * The confirmation for a protected store has to come from a person. The assistant can read the
   * store's domain (list_stores returns it), so a value it passes proves nothing: the person is
   * asked directly through the client instead. Clients that can't ask get pointed to the command line.
   */
  async function confirmProtected(plan: Plan, target: StoreConfig, fromModel: string | undefined): Promise<string> {
    if (env.SYNC_ALLOW_AGENT_CONFIRM === "true") {
      if (fromModel) return fromModel;
      throw new ApplyRefused(`store "${target.alias}" is protected. Pass confirm with the store's myshopify domain.`);
    }
    const cli = `shopify-store-sync-mcp apply ${plan.id} --confirm <the store's myshopify domain>`;
    if (!server.server.getClientCapabilities()?.elicitation) {
      throw new ApplyRefused(`store "${target.alias}" is protected and this client can't ask a person to confirm. Apply the plan from a terminal instead: ${cli}`);
    }
    const count = (a: string) => plan.ops.filter((o) => o.action === a).length;
    let answer;
    try {
      // Sent as a plain request (not elicitInput) so clients that declare the capability the older way, as {}, are asked too.
      answer = await server.server.request(
        {
          method: "elicitation/create",
          params: {
            mode: "form",
            message: `Apply ${count("create")} create(s) and ${count("update")} update(s) from ${plan.source.alias} to the protected store ${target.label ?? target.alias}? Type ${target.domain} to confirm.`,
            requestedSchema: {
              type: "object",
              properties: { domain: { type: "string", title: "Store domain", description: "The target store's myshopify domain" } },
              required: ["domain"],
            },
          },
        },
        ElicitResultSchema,
        { timeout: 10 * 60_000 },
      );
    } catch {
      throw new ApplyRefused(`store "${target.alias}" is protected and the confirmation couldn't be asked for. Apply the plan from a terminal instead: ${cli}`);
    }
    if (answer.action !== "accept") throw new ApplyRefused(`the confirmation for the protected store "${target.alias}" was ${answer.action === "decline" ? "declined" : "cancelled"}; nothing was written.`);
    return String((answer.content as { domain?: unknown } | undefined)?.domain ?? "");
  }

  server.registerTool(
    "list_stores",
    {
      title: "List configured stores",
      description: "List the Shopify stores this server can reach, with their write permissions. Secrets are never returned.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async () => json({ stores: deps.registry.list().map(describeStore) })),
  );

  server.registerTool(
    "list_resource_types",
    {
      title: "List syncable resource types",
      description: "Describe each resource type that can be snapshotted, diffed and synced, how items are keyed, and which are read by default.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async () =>
      json(RESOURCE_KINDS.map((k) => ({ kind: k, default: DEFAULT_KINDS.includes(k), description: ADAPTERS[k].description }))),
    ),
  );

  server.registerTool(
    "snapshot_store",
    {
      title: "Snapshot a store",
      description:
        "Read configuration from one store (or a snapshot folder) in portable form (IDs replaced by handles). Returns counts and keys; set full=true to include the data.",
      inputSchema: {
        store: z.string().describe(SOURCE_HELP),
        ...scopeArgs,
        full: z.boolean().optional().describe("Include each item's data (can be large)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args: ScopeArgs & { store: string; full?: boolean }) => {
      const scope = toScope(args);
      const { snapshot, diffs } = await engine.snapshot(spec(args.store), scope);
      return json({
        store: snapshot.store,
        domain: snapshot.domain,
        takenAt: snapshot.takenAt,
        resources: diffs.map((d) => ({
          kind: d.kind,
          count: d.onlyInSource.length,
          items: args.full ? d.onlyInSource.map((i) => ({ key: i.key, data: i.data })) : d.onlyInSource.map((i) => i.key),
          skipped: snapshot.resources[d.kind]?.skipped.length ? snapshot.resources[d.kind]?.skipped : undefined,
        })),
        files: Object.keys(snapshot.files).length || undefined,
      });
    }),
  );

  server.registerTool(
    "export_snapshot",
    {
      title: "Export a store's configuration to files",
      description:
        "Write a store's configuration to a folder as one JSON file per item (sorted keys, no store IDs), ready to commit to git. Use \"dir:<path>\" as the source of diff_stores or plan_sync to compare or restore from it. Only writes local files, never to Shopify.",
      inputSchema: {
        store: z.string().describe("Store alias to read"),
        dir: z
          .string()
          .describe("Folder to write, inside the snapshot base folder (SYNC_SNAPSHOT_DIR, or the folder the server runs in). Must be empty, new, or an earlier snapshot folder (its item files are replaced)."),
        ...scopeArgs,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async (args: ScopeArgs & { store: string; dir: string }, extra) =>
      json(await engine.export(args.store, resolveInBase(args.dir, base()), toScope(args), reading(extra))),
    ),
  );

  server.registerTool(
    "diff_stores",
    {
      title: "Diff two stores",
      description:
        "Compare configuration between a source and a target: what exists only in the source, what differs (field by field), and what exists only in the target. Either side can be a snapshot folder (\"dir:<path>\"), e.g. to check whether production drifted from the committed config. Read-only.",
      inputSchema: {
        source: z.string().describe(SOURCE_HELP),
        target: z.string().describe(SOURCE_HELP),
        ...scopeArgs,
        show_values: z.boolean().optional().describe("Include before/after values for each changed field (default true)."),
        limit: z.number().int().min(1).max(5000).optional().describe("Max keys listed per section (default 100)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args: ScopeArgs & { source: string; target: string; show_values?: boolean; limit?: number }, extra) => {
      const { diffs, skipped } = await engine.compare(spec(args.source), spec(args.target), toScope(args), reading(extra));
      return json({
        source: args.source,
        target: args.target,
        resources: diffs.map((d) => summarizeDiff(d, args.show_values ?? true, args.limit ?? 100)),
        skipped: skipped.length ? skipped : undefined,
      });
    }),
  );

  server.registerTool(
    "plan_sync",
    {
      title: "Plan a sync",
      description:
        "Build a dry-run plan that would make the target store match the source (a store or a snapshot folder) for the selected resources: creates, updates, conflicts, files to upload and references missing in the target. Nothing is written. Returns a plan_id for apply_plan.",
      inputSchema: {
        source: z.string().describe(SOURCE_HELP),
        target: z.string().describe("Store alias to write to"),
        ...scopeArgs,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args: ScopeArgs & { source: string; target: string }, extra) => {
      const plan = await engine.plan(spec(args.source), args.target, toScope(args), reading(extra));
      const target = deps.registry.get(args.target);
      return json({ ...summarizePlan(plan), targetWritable: target.allowWrites, targetProtected: target.protected || undefined });
    }),
  );

  server.registerTool(
    "get_plan",
    {
      title: "Get a plan",
      description: "Show a previously created sync plan. With no plan_id, list recent plans.",
      inputSchema: {
        plan_id: z.string().optional(),
        full: z.boolean().optional().describe("Return every op, untruncated."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async (args: { plan_id?: string; full?: boolean }) => {
      if (!args.plan_id) {
        const list = engine.plans
          .list()
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 20)
          .map((p) => ({ plan_id: p.id, createdAt: p.createdAt, status: p.status, source: p.source.alias, target: p.target.alias, ops: p.ops.length }));
        return json({ plans: list });
      }
      const plan = engine.plans.get(args.plan_id);
      if (!plan) return fail(`no plan with id ${args.plan_id}`);
      return json(summarizePlan(plan, args.full));
    }),
  );

  server.registerTool(
    "apply_plan",
    {
      title: "Apply a plan",
      description:
        "Write a reviewed plan to the target store. Refused unless the target has allowWrites=true. For a protected store the person is asked to confirm in the client (or applies from the command line); the assistant can't confirm on their behalf. Re-reads the target first and skips anything that changed since planning. Uploads missing files. Creates and updates only, never deletes. Every op is written to an audit log.",
      inputSchema: {
        plan_id: z.string(),
        confirm: z
          .string()
          .optional()
          .describe("Leave empty. Only read when the server runs with SYNC_ALLOW_AGENT_CONFIRM=true (unattended automation); otherwise a protected store is confirmed by the person, not by this argument."),
        only: z.array(z.number().int().positive()).optional().describe("Apply only these op seq numbers."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guard(async (args: { plan_id: string; confirm?: string; only?: number[] }, extra) => {
      const pending = engine.plans.get(args.plan_id);
      if (!pending) return fail(`no plan with id ${args.plan_id}`);
      const target = deps.registry.get(pending.target.alias);
      // Cheap refusals (writes off, expired, already applied) come before anyone is asked to confirm.
      if (!target.allowWrites) throw new ApplyRefused(`writes are disabled for store "${target.alias}". Set "allowWrites": true in its config to enable them.`);
      if (pending.status !== "pending") throw new ApplyRefused(`plan was already ${pending.status.replace("_", " ")}; create a new plan`);
      if (new Date() > new Date(pending.expiresAt)) throw new ApplyRefused("plan has expired; run plan_sync again so it reflects the current target");
      const confirm = target.protected ? await confirmProtected(pending, target, args.confirm) : undefined;
      const report = progressOf(extra);
      const { plan, results } = await engine.apply(args.plan_id, {
        confirm,
        only: args.only,
        onProgress: report ? (done, total, message) => report(message, done, total) : undefined,
      });
      const tally = (o: string) => results.filter((r) => r.outcome === o).length;
      return json({
        plan_id: plan.id,
        status: plan.status,
        totals: { created: tally("created"), updated: tally("updated"), skipped: tally("skipped"), failed: tally("failed") },
        results,
      });
    }),
  );

  server.registerTool(
    "diff_themes",
    {
      title: "Compare theme settings",
      description: `Read-only comparison of theme configuration between two stores: JSON templates, section groups and settings_data.json (default files: ${DEFAULT_THEME_FILES.join(", ")}). Compares the published themes unless theme ids are given. Never writes to a theme. Needs read_themes.`,
      inputSchema: {
        source: z.string().describe("Store alias"),
        target: z.string().describe("Store alias"),
        source_theme: z.string().optional().describe('"main" (default) or a theme id'),
        target_theme: z.string().optional().describe('"main" (default) or a theme id'),
        files: z.array(z.string()).optional().describe('Theme file patterns, e.g. ["templates/product*.json"]'),
        exclude: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args: { source: string; target: string; source_theme?: string; target_theme?: string; files?: string[]; exclude?: string[] }) =>
      json(
        summarizeThemes(
          await engine.themes(args.source, args.target, {
            sourceTheme: args.source_theme,
            targetTheme: args.target_theme,
            files: args.files,
            exclude: args.exclude,
          }),
        ),
      ),
    ),
  );

  return server;
}
