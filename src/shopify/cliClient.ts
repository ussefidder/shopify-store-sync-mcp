import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreConfig } from "../config.js";
import { ShopifyError, type AdminClient, type GraphQLError } from "./client.js";

/*
 * Talks to a store through Shopify CLI's own sign-in (`shopify store auth`), so no app,
 * client secret or access token is needed. Each request runs `shopify store execute`,
 * the CLI's supported command, rather than reading the CLI's private token storage.
 */

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (bin: string, args: string[]) => Promise<RunResult>;

export const READ_SCOPES = [
  "read_products",
  "read_metaobjects",
  "read_metaobject_definitions",
  "read_online_store_pages",
  "read_online_store_navigation",
  "read_legal_policies",
  "read_translations",
  "read_locales",
  "read_files",
  "read_themes",
  "read_content",
];
export const WRITE_SCOPES = [
  "write_products",
  "write_metaobjects",
  "write_metaobject_definitions",
  "write_online_store_pages",
  "write_online_store_navigation",
  "write_legal_policies",
  "write_translations",
  "write_files",
];

/** Scopes to request for a store: read-only unless the store config allows writes. */
export function scopesFor(store: Pick<StoreConfig, "allowWrites">): string[] {
  return store.allowWrites ? [...READ_SCOPES, ...WRITE_SCOPES] : READ_SCOPES;
}

export function cliBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHOPIFY_CLI_BIN || "shopify";
}

/** Quote an argument for cmd.exe, which runs the CLI's .cmd shim on Windows. */
export function quoteWindowsArg(a: string): string {
  return /^[A-Za-z0-9_\-.:\\/,=@]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`;
}

/** Start the CLI; on Windows it's a .cmd shim, so it goes through the shell with quoted arguments. */
export function spawnCli(bin: string, args: string[], stdio: "pipe" | "inherit"): ChildProcess {
  const opts: SpawnOptions = { stdio: stdio === "pipe" ? ["ignore", "pipe", "pipe"] : "inherit" };
  return process.platform === "win32"
    ? spawn([bin, ...args].map(quoteWindowsArg).join(" "), { ...opts, shell: true })
    : spawn(bin, args, opts);
}

export const defaultRunner: Runner = (bin, args) =>
  new Promise((resolve, reject) => {
    const child = spawnCli(bin, args, "pipe");
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.on("error", (e: NodeJS.ErrnoException) =>
      reject(
        e.code === "ENOENT"
          ? new ShopifyError(`Shopify CLI not found ("${bin}"). Install it with: npm install -g @shopify/cli`)
          : e,
      ),
    );
    child.on("close", (code: number | null) => resolve({ code: code ?? 1, stdout, stderr }));
  });

type CliOutput = {
  data?: unknown;
  errors?: GraphQLError[];
  error?: { message?: string; nextSteps?: unknown; details?: { errors?: GraphQLError[] } };
};

/**
 * Read the result of `shopify store execute --json`. Progress events come first, one JSON
 * object per line; the result follows, possibly pretty-printed over several lines.
 * Shopify CLI 5 wraps the result as { data, extensions }; CLI 4.9 prints the data object itself.
 */
export function parseCliOutput(text: string): CliOutput | undefined {
  const rest: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("{") && t.endsWith("}")) {
      try {
        const obj = JSON.parse(t) as { type?: string };
        if (obj && obj.type === "progress") continue;
      } catch {
        // part of a multi-line document
      }
    }
    rest.push(line);
  }
  const body = rest.join("\n").trim();
  const start = body.indexOf("{");
  if (start < 0) return undefined;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(body.slice(start)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  if ("error" in obj || "errors" in obj) return obj as CliOutput;
  const keys = Object.keys(obj);
  if ("data" in obj && keys.every((k) => k === "data" || k === "extensions")) return obj as CliOutput;
  return { data: obj };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ShopifyCliClient implements AdminClient {
  constructor(
    readonly store: StoreConfig,
    private readonly run: Runner = defaultRunner,
    private readonly bin = cliBin(),
    private readonly maxRetries = 5,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  async request<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "store-sync-cli-"));
    try {
      const queryFile = join(dir, "query.graphql");
      const varsFile = join(dir, "variables.json");
      writeFileSync(queryFile, query);
      writeFileSync(varsFile, JSON.stringify(variables));
      const args = [
        "store",
        "execute",
        "--store",
        this.store.domain,
        "--query-file",
        queryFile,
        "--variable-file",
        varsFile,
        "--version",
        this.store.apiVersion,
        "--json",
        "--no-input",
        "--no-color",
      ];
      // The CLI refuses mutations unless asked; writes are still gated by allowWrites and plans.
      if (/^\s*mutation\b/.test(query)) args.push("--allow-mutations");

      for (let attempt = 0; ; attempt++) {
        const res = await this.run(this.bin, args);
        const out = parseCliOutput(res.stdout) ?? parseCliOutput(res.stderr);
        const errors = out?.errors ?? out?.error?.details?.errors;
        const throttled = errors?.some((e) => e.extensions?.code === "THROTTLED");
        if (throttled && attempt < this.maxRetries) {
          await this.wait(Math.min(16_000, 1000 * 2 ** attempt));
          continue;
        }
        if (errors?.length) {
          throw new ShopifyError(`${this.store.domain}: ${errors.map((e) => e.message).join("; ")}`, errors);
        }
        if (out?.error) {
          const msg = out.error.message ?? "Shopify CLI failed";
          if (/no stored app authentication|re-run .*store auth|missing.*scope|not authenticated|expired/i.test(msg)) {
            throw new ShopifyError(
              `${this.store.domain}: not signed in through Shopify CLI, or the sign-in expired or lacks a scope. Run: shopify-store-sync-mcp connect ${this.store.alias}`,
              out.error,
            );
          }
          throw new ShopifyError(`${this.store.domain}: ${msg}`, out.error);
        }
        if (res.code !== 0 || !out || out.data === undefined || out.data === null) {
          const detail = (res.stderr || res.stdout).trim().slice(0, 500);
          throw new ShopifyError(`${this.store.domain}: Shopify CLI exited with code ${res.code}${detail ? `: ${detail}` : ""}`);
        }
        return out.data as T;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
