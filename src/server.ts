import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { applyPlan, ApplyRefused } from "./apply.js";
import { StoreRegistry, type StoreConfig } from "./config.js";
import { diffItems, preview, type KeyFilter, type ResourceDiff } from "./diff.js";
import { buildPlan, PlanStore, type Plan } from "./plan.js";
import { RefToGidResolver } from "./refs.js";
import { ADAPTERS, RESOURCE_KINDS, type FetchOptions, type ResourceKind } from "./resources/index.js";
import { DEFAULT_OWNER_TYPES } from "./resources/metafieldDefinitions.js";
import { ShopifyAdminClient, type AdminClient } from "./shopify/client.js";
import { takeSnapshot } from "./snapshot.js";

export const VERSION = "0.1.0";

export interface ServerDeps {
  registry: StoreRegistry;
  plans?: PlanStore;
  clientFactory?: (store: StoreConfig) => AdminClient;
}

const resourcesArg = z
  .array(z.enum(RESOURCE_KINDS))
  .min(1)
  .optional()
  .describe(`Resource types to include. Default: all (${RESOURCE_KINDS.join(", ")}).`);

const scopeArgs = {
  resources: resourcesArg,
  owner_types: z
    .array(z.string())
    .optional()
    .describe(`Metafield owner types for metafield_definitions. Default: ${DEFAULT_OWNER_TYPES.join(", ")}.`),
  metaobject_types: z.array(z.string()).optional().describe("Limit metaobjects to these types. Default: all non-reserved types."),
  include: z
    .array(z.string())
    .optional()
    .describe('Only keys matching one of these globs, e.g. ["PRODUCT.custom.*", "faq/*", "main-menu"].'),
  exclude: z.array(z.string()).optional().describe("Drop keys matching any of these globs."),
};

type ScopeInput = {
  resources?: ResourceKind[];
  owner_types?: string[];
  metaobject_types?: string[];
  include?: string[];
  exclude?: string[];
};

function scope(input: ScopeInput): { kinds: ResourceKind[]; fetch: FetchOptions; filter: KeyFilter } {
  return {
    kinds: input.resources ?? [...RESOURCE_KINDS],
    fetch: { ownerTypes: input.owner_types, metaobjectTypes: input.metaobject_types },
    filter: { include: input.include, exclude: input.exclude },
  };
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

function describeStore(s: StoreConfig) {
  return {
    alias: s.alias,
    domain: s.domain,
    label: s.label,
    apiVersion: s.apiVersion,
    auth: s.accessToken ? "access_token" : "client_credentials",
    allowWrites: s.allowWrites,
    protected: s.protected,
  };
}

function summarizeDiff(d: ResourceDiff, showValues: boolean, limit: number) {
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
      changes: c.changes.map((ch) =>
        showValues ? { path: ch.path, source: preview(ch.source), target: preview(ch.target) } : ch.path,
      ),
    })),
    onlyInTarget: d.onlyInTarget.slice(0, limit).map((i) => i.key),
    truncated: Math.max(d.onlyInSource.length, d.changed.length, d.onlyInTarget.length) > limit || undefined,
  };
}

function summarizePlan(plan: Plan, full = false) {
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
    note: "Nothing has been written. Review, then call apply_plan with this plan_id. Items only in the target are never deleted.",
  };
}

export function createServer(deps: ServerDeps): McpServer {
  const { registry } = deps;
  const plans = deps.plans ?? new PlanStore();
  const clients = new Map<string, AdminClient>();
  const clientFor = (alias: string): AdminClient => {
    const store = registry.get(alias);
    let c = clients.get(alias);
    if (!c) {
      c = deps.clientFactory ? deps.clientFactory(store) : new ShopifyAdminClient(store);
      clients.set(alias, c);
    }
    return c;
  };

  const guard =
    <A>(fn: (args: A) => Promise<ReturnType<typeof json>>) =>
    async (args: A) => {
      try {
        return await fn(args);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    };

  async function compare(source: string, target: string, input: ScopeInput) {
    if (source === target) throw new Error("source and target must be different stores");
    const { kinds, fetch, filter } = scope(input);
    const [s, t] = [clientFor(source), clientFor(target)];
    const [a, b] = await Promise.all([takeSnapshot(s, kinds, fetch), takeSnapshot(t, kinds, fetch)]);
    const diffs = kinds.map((k) => diffItems(k, a.resources[k]?.items ?? [], b.resources[k]?.items ?? [], filter));
    const skipped = kinds.flatMap((k) => (a.resources[k]?.skipped ?? []).map((x) => ({ kind: k, ...x })));
    return { s, t, diffs, skipped };
  }

  const server = new McpServer({ name: "shopify-store-sync-mcp", version: VERSION });

  server.registerTool(
    "list_stores",
    {
      title: "List configured stores",
      description: "List the Shopify stores this server can reach, with their write permissions. Secrets are never returned.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async () => json({ stores: registry.list().map(describeStore) })),
  );

  server.registerTool(
    "list_resource_types",
    {
      title: "List syncable resource types",
      description: "Describe each resource type that can be snapshotted, diffed and synced, and how items are keyed.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async () => json(RESOURCE_KINDS.map((k) => ({ kind: k, description: ADAPTERS[k].description })))),
  );

  server.registerTool(
    "snapshot_store",
    {
      title: "Snapshot a store",
      description:
        "Read configuration from one store in portable form (IDs replaced by handles). Returns counts and keys; set full=true to include the data.",
      inputSchema: {
        store: z.string().describe("Store alias from list_stores"),
        ...scopeArgs,
        full: z.boolean().optional().describe("Include each item's data (can be large)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args: ScopeInput & { store: string; full?: boolean }) => {
      const { kinds, fetch, filter } = scope(args);
      const snap = await takeSnapshot(clientFor(args.store), kinds, fetch);
      const { diffs } = { diffs: kinds.map((k) => diffItems(k, snap.resources[k]?.items ?? [], [], filter)) };
      return json({
        store: snap.store,
        domain: snap.domain,
        takenAt: snap.takenAt,
        resources: diffs.map((d) => ({
          kind: d.kind,
          count: d.onlyInSource.length,
          items: args.full ? d.onlyInSource.map((i) => ({ key: i.key, data: i.data })) : d.onlyInSource.map((i) => i.key),
          skipped: snap.resources[d.kind]?.skipped.length ? snap.resources[d.kind]?.skipped : undefined,
        })),
      });
    }),
  );

  server.registerTool(
    "diff_stores",
    {
      title: "Diff two stores",
      description:
        "Compare configuration between a source and a target store: what exists only in the source, what differs (field by field), and what exists only in the target. Read-only.",
      inputSchema: {
        source: z.string().describe("Store alias to copy from"),
        target: z.string().describe("Store alias to compare against"),
        ...scopeArgs,
        show_values: z.boolean().optional().describe("Include before/after values for each changed field (default true)."),
        limit: z.number().int().min(1).max(5000).optional().describe("Max keys listed per section (default 100)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args: ScopeInput & { source: string; target: string; show_values?: boolean; limit?: number }) => {
      const { diffs, skipped } = await compare(args.source, args.target, args);
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
        "Build a dry-run plan that would make the target match the source for the selected resources: creates, updates and conflicts, plus references that are missing in the target. Nothing is written. Returns a plan_id for apply_plan.",
      inputSchema: {
        source: z.string().describe("Store alias to copy from"),
        target: z.string().describe("Store alias to write to"),
        ...scopeArgs,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (args: ScopeInput & { source: string; target: string }) => {
      const { s, t, diffs, skipped } = await compare(args.source, args.target, args);
      const plan = await buildPlan({
        source: { alias: s.store.alias, domain: s.store.domain },
        target: { alias: t.store.alias, domain: t.store.domain },
        diffs,
        skipped,
        resolver: new RefToGidResolver(t),
      });
      plans.save(plan);
      const target = registry.get(args.target);
      return json({
        ...summarizePlan(plan),
        targetWritable: target.allowWrites,
        targetProtected: target.protected || undefined,
      });
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
        const list = plans
          .list()
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 20)
          .map((p) => ({ plan_id: p.id, createdAt: p.createdAt, status: p.status, source: p.source.alias, target: p.target.alias, ops: p.ops.length }));
        return json({ plans: list });
      }
      const plan = plans.get(args.plan_id);
      if (!plan) return fail(`no plan with id ${args.plan_id}`);
      return json(summarizePlan(plan, args.full));
    }),
  );

  server.registerTool(
    "apply_plan",
    {
      title: "Apply a plan",
      description:
        "Write a reviewed plan to the target store. Refused unless the target has allowWrites=true; protected stores also need confirm=<target myshopify domain>. Re-reads the target first and skips anything that changed since planning. Creates and updates only, never deletes. Every op is written to an audit log.",
      inputSchema: {
        plan_id: z.string(),
        confirm: z.string().optional().describe("Target's myshopify domain; required for protected stores."),
        only: z.array(z.number().int().positive()).optional().describe("Apply only these op seq numbers."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    guard(async (args: { plan_id: string; confirm?: string; only?: number[] }) => {
      const plan = plans.get(args.plan_id);
      if (!plan) return fail(`no plan with id ${args.plan_id}`);
      try {
        const results = await applyPlan(plan, clientFor(plan.target.alias), { confirm: args.confirm, only: args.only });
        plans.save(plan);
        const tally = (o: string) => results.filter((r) => r.outcome === o).length;
        return json({
          plan_id: plan.id,
          status: plan.status,
          totals: { created: tally("created"), updated: tally("updated"), skipped: tally("skipped"), failed: tally("failed") },
          results,
        });
      } catch (err) {
        if (err instanceof ApplyRefused) return fail(`Refused: ${err.message}`);
        throw err;
      }
    }),
  );

  return server;
}
