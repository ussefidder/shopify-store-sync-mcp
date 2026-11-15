import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export const DEFAULT_API_VERSION = "2026-10";

const storeSchema = z
  .object({
    domain: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i, "domain must look like my-store.myshopify.com"),
    accessToken: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
    /** "shopify-cli": use the sign-in saved by `shopify store auth` (no app or token needed). */
    auth: z.enum(["shopify-cli"]).optional(),
    apiVersion: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    allowWrites: z.boolean().default(false),
    protected: z.boolean().default(false),
    label: z.string().optional(),
  })
  .refine((s) => s.auth === "shopify-cli" || Boolean(s.accessToken) || (Boolean(s.clientId) && Boolean(s.clientSecret)), {
    message: 'each store needs "auth": "shopify-cli", an accessToken, or clientId + clientSecret',
  });

export type StoreConfig = z.infer<typeof storeSchema> & { alias: string; apiVersion: string };

const fileSchema = z.object({ stores: z.record(z.string(), z.unknown()) });

/** Replace "env:VAR_NAME" strings with the value of that environment variable. */
function expandEnv(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string" && value.startsWith("env:")) {
    const name = value.slice(4);
    const resolved = env[name];
    if (resolved === undefined) throw new Error(`environment variable ${name} is not set`);
    return resolved;
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v, env)]));
  }
  return value;
}

export function parseStores(raw: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): StoreConfig[] {
  const out: StoreConfig[] = [];
  for (const [alias, value] of Object.entries(raw)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(alias)) throw new Error(`invalid store alias "${alias}" (use letters, digits, - and _)`);
    const parsed = storeSchema.safeParse(expandEnv(value, env));
    if (!parsed.success) {
      throw new Error(`store "${alias}": ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }
    out.push({ ...parsed.data, alias, apiVersion: parsed.data.apiVersion ?? env.SHOPIFY_API_VERSION ?? DEFAULT_API_VERSION });
  }
  return out;
}

/**
 * Load stores from, in order of precedence:
 * 1. SHOPIFY_STORES (inline JSON: { "alias": { ...store } })
 * 2. SHOPIFY_STORES_FILE, or ./stores.json ({ "stores": { "alias": { ...store } } })
 * 3. SHOPIFY_STORE_DOMAIN + SHOPIFY_ACCESS_TOKEN (or SHOPIFY_CLIENT_ID/SECRET) as alias "default"
 */
export function loadStores(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): StoreConfig[] {
  if (env.SHOPIFY_STORES) {
    let json: unknown;
    try {
      json = JSON.parse(env.SHOPIFY_STORES);
    } catch {
      throw new Error("SHOPIFY_STORES is not valid JSON");
    }
    return parseStores(z.record(z.string(), z.unknown()).parse(json), env);
  }

  const file = env.SHOPIFY_STORES_FILE ? resolve(cwd, env.SHOPIFY_STORES_FILE) : resolve(cwd, "stores.json");
  if (existsSync(file)) {
    const json = fileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    return parseStores(json.stores, env);
  }

  if (env.SHOPIFY_STORE_DOMAIN) {
    return parseStores(
      {
        default: {
          domain: env.SHOPIFY_STORE_DOMAIN,
          accessToken: env.SHOPIFY_ACCESS_TOKEN,
          clientId: env.SHOPIFY_CLIENT_ID,
          clientSecret: env.SHOPIFY_CLIENT_SECRET,
          auth: env.SHOPIFY_AUTH === "shopify-cli" ? "shopify-cli" : undefined,
          allowWrites: env.SHOPIFY_ALLOW_WRITES === "true",
        },
      },
      env,
    );
  }

  return [];
}

export class StoreRegistry {
  private readonly byAlias = new Map<string, StoreConfig>();

  constructor(stores: StoreConfig[]) {
    for (const s of stores) this.byAlias.set(s.alias, s);
  }

  get(alias: string): StoreConfig {
    const store = this.byAlias.get(alias);
    if (!store) {
      const known = [...this.byAlias.keys()].join(", ") || "none configured";
      throw new Error(`unknown store "${alias}" (known: ${known})`);
    }
    return store;
  }

  list(): StoreConfig[] {
    return [...this.byAlias.values()];
  }
}
