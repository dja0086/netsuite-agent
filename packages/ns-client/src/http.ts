import { M2MTokenProvider } from "./auth/oauth2-m2m";
import { configFromEnv, type NsConfig } from "./config";
import { parseNsError } from "./errors";
import { GovernanceLimiter } from "./governance/limiter";
import { secretsFromEnv } from "./secrets";

export type NsBase = "rest" | "restlet";

export interface NsRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  base: NsBase;
  /** Path beginning with "/", e.g. /services/rest/query/v1/suiteql */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
}

/** The surface every helper and tool depends on. Tests pass a fake implementation. */
export interface NsRequester {
  request<T = unknown>(req: NsRequest): Promise<T>;
}

export interface TokenSource {
  getToken(): Promise<string>;
  invalidate(): void;
}

export interface NsClientOptions {
  config: NsConfig;
  tokens: TokenSource;
  limiter: GovernanceLimiter;
  fetch?: typeof fetch;
}

export class NsClient implements NsRequester {
  readonly config: NsConfig;
  readonly limiter: GovernanceLimiter;
  private readonly tokens: TokenSource;
  private readonly fetchImpl: typeof fetch;

  constructor(options: NsClientOptions) {
    this.config = options.config;
    this.tokens = options.tokens;
    this.limiter = options.limiter;
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Wires config, secrets, token provider and limiter from environment variables. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): NsClient {
    const config = configFromEnv(env);
    const tokens = new M2MTokenProvider({
      tokenUrl: config.tokenUrl,
      clientId: config.clientId,
      certId: config.certId,
      secrets: secretsFromEnv(env),
    });
    const limiter = new GovernanceLimiter({ maxConcurrency: config.maxConcurrency });
    return new NsClient({ config, tokens, limiter });
  }

  buildUrl(req: Pick<NsRequest, "base" | "path" | "query">): string {
    if (!req.path.startsWith("/")) throw new Error(`Path must start with "/": ${req.path}`);
    const base = req.base === "rest" ? this.config.restBaseUrl : this.config.restletBaseUrl;
    const url = new URL(base + req.path);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  request<T = unknown>(req: NsRequest): Promise<T> {
    return this.limiter.run(() => this.send<T>(req, false));
  }

  private async send<T>(req: NsRequest, isRetryAfter401: boolean): Promise<T> {
    const token = await this.tokens.getToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...req.headers,
    };
    let body: string | undefined;
    if (req.body !== undefined) {
      headers["Content-Type"] ??= "application/json";
      body = JSON.stringify(req.body);
    }

    const response = await this.fetchImpl(this.buildUrl(req), { method: req.method, headers, body });

    if (response.status === 401 && !isRetryAfter401) {
      // Token revoked or expired early: refresh once, then give up.
      this.tokens.invalidate();
      return this.send<T>(req, true);
    }
    const text = await response.text();
    if (!response.ok) throw parseNsError(response.status, text);
    if (!text) return undefined as T;
    const type = response.headers.get("content-type") ?? "";
    return (type.includes("json") ? JSON.parse(text) : text) as T;
  }
}
