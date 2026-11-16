import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreConfig } from "../config.js";
import { envNumber, ShopifyError, type AdminClient, type GraphQLError } from "./client.js";

/*
 * Talks to a store through Shopify CLI's own sign-in (`shopify store auth`), so no app,
 * client secret or access token is needed. Each request runs `shopify store execute`,
 * the CLI's supported command, rather than reading the CLI's private token storage.
 */

export type RunResult = { code: number; stdout: string; stderr: string; timedOut?: boolean };
export type Runner = (bin: string, args: string[], opts?: { cwd?: string }) => Promise<RunResult>;

/** How long one `shopify` command may run before it is stopped. */
export const cliTimeoutMs = () => envNumber("SYNC_CLI_TIMEOUT_MS", 120_000);

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
  "read_discounts",
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

/**
 * Scopes to request for a store: read-only unless the store config allows writes. `extra` adds
 * read scopes the defaults leave out on purpose, such as read_customers or read_orders, for
 * comparing the metafield definitions of those owner types. Only read_* scopes can be added.
 */
export function scopesFor(store: Pick<StoreConfig, "allowWrites">, extra: string[] = []): string[] {
  for (const s of extra) {
    if (!/^read_[a-z_]+$/.test(s)) throw new Error(`"${s}": only read scopes (read_...) can be added; write access follows the store's allowWrites`);
  }
  const base = store.allowWrites ? [...READ_SCOPES, ...WRITE_SCOPES] : READ_SCOPES;
  return [...new Set([...base, ...extra])];
}

/** Oldest Shopify CLI this tool works with (`store execute --no-input` and friends). */
export const MIN_CLI_VERSION = "4.9.0";

export function parseCliVersion(text: string): string | undefined {
  return /(\d+)\.(\d+)\.(\d+)/.exec(text)?.[0];
}

/** Negative when a is older than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** The installed Shopify CLI version; throws a clear message when it is too old. */
export async function checkCliVersion(bin = cliBin(), run: Runner = defaultRunner): Promise<string | undefined> {
  const res = await run(bin, ["version"]);
  const version = parseCliVersion(`${res.stdout}\n${res.stderr}`);
  if (version && compareVersions(version, MIN_CLI_VERSION) < 0) {
    throw new ShopifyError(
      `Shopify CLI ${version} is too old: this tool needs ${MIN_CLI_VERSION} or newer. Update it with: npm install -g @shopify/cli@latest`,
    );
  }
  return version;
}

export function cliBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHOPIFY_CLI_BIN || "shopify";
}

/**
 * Quote an argument for cmd.exe, which runs the CLI's .cmd shim on Windows.
 * cmd.exe expands %VAR% and !VAR! even inside quotes and has no reliable way to escape a quote,
 * so an argument holding one of those characters is refused rather than passed along.
 * Nothing this tool sends needs them: file names are passed relative to the working folder.
 */
export function quoteWindowsArg(a: string): string {
  if (/^[A-Za-z0-9_\-.:\\/,=@]+$/.test(a)) return a;
  if (/[%!^"\r\n\0]/.test(a)) {
    throw new ShopifyError(`can't pass this value to Shopify CLI on Windows (it contains % ! ^ or a quote): ${a.slice(0, 60)}`);
  }
  return `"${a}"`;
}

/** Start the CLI; on Windows it's a .cmd shim, so it goes through the shell with quoted arguments. */
export function spawnCli(bin: string, args: string[], stdio: "pipe" | "inherit", cwd?: string): ChildProcess {
  const opts: SpawnOptions = { stdio: stdio === "pipe" ? ["ignore", "pipe", "pipe"] : "inherit", cwd };
  return process.platform === "win32"
    ? spawn([bin, ...args].map(quoteWindowsArg).join(" "), { ...opts, shell: true })
    : spawn(bin, args, opts);
}

/** Stop a CLI process and, on Windows, the node process its shim started. */
function stop(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

export function makeRunner(timeoutMs: number = cliTimeoutMs()): Runner {
  return (bin, args, opts) =>
    new Promise((resolve, reject) => {
      const child = spawnCli(bin, args, "pipe", opts?.cwd);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        stop(child);
      }, timeoutMs);
      child.stdout!.on("data", (d) => (stdout += d));
      child.stderr!.on("data", (d) => (stderr += d));
      child.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          e.code === "ENOENT"
            ? new ShopifyError(`Shopify CLI not found ("${bin}"). Install it with: npm install -g @shopify/cli`)
            : e,
        );
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr, timedOut });
      });
    });
}

export const defaultRunner: Runner = (bin, args, opts) => makeRunner()(bin, args, opts);

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

/** At most this many `shopify` processes run at once per store (SYNC_CLI_CONCURRENCY, default 4). */
export const cliConcurrency = () => Math.max(1, Math.min(16, envNumber("SYNC_CLI_CONCURRENCY", 4)));

export class ShopifyCliClient implements AdminClient {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly limit = cliConcurrency();

  constructor(
    readonly store: StoreConfig,
    private readonly run: Runner = defaultRunner,
    private readonly bin = cliBin(),
    private readonly maxRetries = 5,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  async request<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await this.execute<T>(query, variables);
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  private async execute<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "store-sync-cli-"));
    try {
      // The CLI runs inside the temp folder and gets plain file names, so no path (which holds the
      // user's name on Windows) ever has to be quoted for a shell.
      const queryFile = "query.graphql";
      const varsFile = "variables.json";
      writeFileSync(join(dir, queryFile), query);
      writeFileSync(join(dir, varsFile), JSON.stringify(variables));
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
      const mutation = /^\s*mutation\b/.test(query);
      if (mutation) args.push("--allow-mutations");

      for (let attempt = 0; ; attempt++) {
        const res = await this.run(this.bin, args, { cwd: dir });
        if (res.timedOut) {
          // A read can simply be asked again. A write is never repeated blindly: it may have gone through.
          if (!mutation && attempt < 1) continue;
          throw new ShopifyError(
            mutation
              ? `${this.store.domain}: Shopify CLI gave no answer and was stopped. The write may or may not have been saved; plan again to see the current state.`
              : `${this.store.domain}: Shopify CLI gave no answer and was stopped (set SYNC_CLI_TIMEOUT_MS to wait longer)`,
          );
        }
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
        if (res.code !== 0 && /nonexistent flag|unknown flag|command .* not found/i.test(`${res.stdout}${res.stderr}`)) {
          // An older CLI lacks flags this tool passes; say which version is needed instead of the raw error.
          await checkCliVersion(this.bin, this.run);
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
