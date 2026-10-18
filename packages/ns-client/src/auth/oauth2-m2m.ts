import { SignJWT, importPKCS8, type CryptoKey } from "jose";
import type { SecretsBackend } from "../secrets";

export type SigningAlg = "PS256" | "PS384" | "PS512" | "ES256" | "ES384" | "ES512";

export interface M2MTokenProviderOptions {
  tokenUrl: string;
  clientId: string;
  /** Certificate ID shown on the OAuth 2.0 Client Credentials (M2M) setup page. */
  certId: string;
  secrets: SecretsBackend;
  scopes?: string[];
  alg?: SigningAlg;
  /** Refresh this many ms before expiry. Default 60 s. */
  refreshSkewMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * OAuth 2.0 client credentials flow for NetSuite: signs a short-lived JWT client assertion
 * with the certificate's private key and exchanges it for an access token.
 * Tokens are cached; concurrent callers share one in-flight request.
 */
export class M2MTokenProvider {
  private cached: CachedToken | undefined;
  private inflight: Promise<string> | undefined;
  private key: CryptoKey | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: M2MTokenProviderOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getToken(): Promise<string> {
    const skew = this.options.refreshSkewMs ?? 60_000;
    if (this.cached && this.cached.expiresAt - skew > this.now()) return this.cached.token;
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** Drops the cached token, e.g. after a 401. */
  invalidate(): void {
    this.cached = undefined;
  }

  private async signingKey(): Promise<CryptoKey> {
    if (!this.key) {
      const pem = await this.options.secrets.get("netsuite/m2m-private-key");
      this.key = await importPKCS8(pem, this.options.alg ?? "PS256");
    }
    return this.key;
  }

  private async fetchToken(): Promise<string> {
    const { tokenUrl, clientId, certId } = this.options;
    const nowSec = Math.floor(this.now() / 1000);
    const assertion = await new SignJWT({ scope: this.options.scopes ?? ["rest_webservices", "restlets"] })
      .setProtectedHeader({ alg: this.options.alg ?? "PS256", typ: "JWT", kid: certId })
      .setIssuer(clientId)
      .setAudience(tokenUrl)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 300)
      .sign(await this.signingKey());

    const response = await this.fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
      }),
    });

    if (!response.ok) {
      // The body can echo request details; report the status only.
      throw new Error(`NetSuite token request failed with HTTP ${response.status}`);
    }
    const json = (await response.json()) as { access_token?: string; expires_in?: number | string };
    if (!json.access_token) throw new Error("NetSuite token response had no access_token");
    const expiresIn = Number(json.expires_in ?? 3600);
    this.cached = { token: json.access_token, expiresAt: this.now() + expiresIn * 1000 };
    return json.access_token;
  }
}
