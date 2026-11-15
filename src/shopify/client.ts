import type { StoreConfig } from "../config.js";

export interface GraphQLError {
  message: string;
  extensions?: { code?: string; [k: string]: unknown };
}

export interface UserError {
  field?: string[] | null;
  message: string;
  code?: string | null;
}

export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ShopifyError";
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Minimal interface the rest of the code depends on, so tests can use a fake. */
export interface AdminClient {
  readonly store: StoreConfig;
  request<T = any>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ShopifyAdminClient implements AdminClient {
  private token: string | undefined;
  private tokenExpiresAt = 0;

  constructor(
    readonly store: StoreConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly maxRetries = 5,
  ) {
    this.token = store.accessToken;
    if (store.accessToken) this.tokenExpiresAt = Number.POSITIVE_INFINITY;
  }

  /** Client-credentials grant for apps created in the Shopify Dev Dashboard. Tokens are cached until shortly before expiry. */
  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const { clientId, clientSecret, domain } = this.store;
    if (!clientId || !clientSecret) throw new ShopifyError(`store "${this.store.alias}" has no credentials`);

    const res = await this.fetchImpl(`https://${domain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }).toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Shopify answers with an HTML page whose title carries the OAuth error code.
      const code = /Oauth error ([a-z_]+)/i.exec(text)?.[1] ?? /"error"\s*:\s*"([^"]+)"/.exec(text)?.[1];
      const hint =
        code === "app_not_installed"
          ? ": the app isn't installed on this store yet (install it from the Dev Dashboard, then retry)"
          : code === "shop_not_permitted"
            ? ": client credentials only work on stores owned by the same organization as the app; use an access token instead"
            : code
              ? ` (${code})`
              : "";
      throw new ShopifyError(`token request for ${domain} failed with HTTP ${res.status}${hint}`, text || undefined);
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new ShopifyError(`token response for ${domain} had no access_token`);
    this.token = body.access_token;
    const ttl = (body.expires_in ?? 3600) * 1000;
    this.tokenExpiresAt = Date.now() + Math.max(ttl - 60_000, 30_000);
    return this.token;
  }

  async request<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const url = `https://${this.store.domain}/admin/api/${this.store.apiVersion}/graphql.json`;

    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (res.status === 401 && this.store.clientId && attempt === 0) {
        this.tokenExpiresAt = 0; // token expired or revoked, fetch a new one once
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      if (!res.ok) {
        throw new ShopifyError(`${this.store.domain}: HTTP ${res.status}`, await res.text().catch(() => undefined));
      }

      const body = (await res.json()) as {
        data?: T;
        errors?: GraphQLError[];
        extensions?: { cost?: { requestedQueryCost?: number; throttleStatus?: { currentlyAvailable: number; restoreRate: number } } };
      };

      const throttled = body.errors?.some((e) => e.extensions?.code === "THROTTLED");
      if (throttled && attempt < this.maxRetries) {
        const cost = body.extensions?.cost;
        const needed = (cost?.requestedQueryCost ?? 100) - (cost?.throttleStatus?.currentlyAvailable ?? 0);
        const rate = cost?.throttleStatus?.restoreRate ?? 50;
        await sleep(Math.max(1000, Math.ceil((needed / rate) * 1000)));
        continue;
      }
      if (body.errors?.length) {
        throw new ShopifyError(`${this.store.domain}: ${body.errors.map((e) => e.message).join("; ")}`, body.errors);
      }
      if (!body.data) throw new ShopifyError(`${this.store.domain}: empty response`);
      return body.data;
    }
  }
}

function backoff(attempt: number): number {
  return Math.min(16_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

/** Throw if a mutation payload has userErrors. */
export function assertNoUserErrors(payload: { userErrors?: UserError[] } | null | undefined, what: string): void {
  const errors = payload?.userErrors ?? [];
  if (errors.length) {
    const msg = errors.map((e) => (e.field?.length ? `${e.field.join(".")}: ${e.message}` : e.message)).join("; ");
    throw new ShopifyError(`${what} failed: ${msg}`, errors);
  }
}

/** Walk a cursor-paginated connection. `pick` returns the connection object from the response. */
export async function paginate<N>(
  client: AdminClient,
  query: string,
  variables: Record<string, unknown>,
  pick: (data: any) => { nodes: N[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } },
  maxItems = 10_000,
): Promise<N[]> {
  const out: N[] = [];
  let after: string | null = null;
  do {
    const data = await client.request(query, { ...variables, after });
    const conn = pick(data);
    out.push(...conn.nodes);
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after && out.length < maxItems);
  return out;
}
