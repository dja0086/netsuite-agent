import { exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { M2MTokenProvider, type SecretsBackend } from "../src";

const TOKEN_URL = "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token";
let pkcs8 = "";
let spki = "";

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("PS256", { extractable: true });
  pkcs8 = await exportPKCS8(privateKey);
  spki = await exportSPKI(publicKey);
});

function setup(expiresIn = 3600) {
  const secrets: SecretsBackend = { get: async () => pkcs8 };
  const bodies: URLSearchParams[] = [];
  let now = 1_800_000_000_000;
  const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(new URLSearchParams(String(init?.body)));
    await new Promise((r) => setTimeout(r, 1));
    return new Response(JSON.stringify({ access_token: `token-${bodies.length}`, expires_in: expiresIn }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const provider = new M2MTokenProvider({
    tokenUrl: TOKEN_URL,
    clientId: "client-123",
    certId: "cert-abc",
    secrets,
    fetch: fetchMock,
    now: () => now,
  });
  return { provider, bodies, advance: (ms: number) => (now += ms) };
}

describe("M2MTokenProvider", () => {
  it("sends a signed client assertion NetSuite can verify", async () => {
    const { provider, bodies } = setup();
    await expect(provider.getToken()).resolves.toBe("token-1");

    const body = bodies[0]!;
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");

    const { payload, protectedHeader } = await jwtVerify(body.get("client_assertion")!, await importSPKI(spki, "PS256"), {
      currentDate: new Date(1_800_000_000_000),
    });
    expect(protectedHeader).toMatchObject({ alg: "PS256", kid: "cert-abc", typ: "JWT" });
    expect(payload).toMatchObject({ iss: "client-123", aud: TOKEN_URL, scope: ["rest_webservices", "restlets"] });
    expect(payload.exp! - payload.iat!).toBe(300);
  });

  it("caches the token until shortly before expiry", async () => {
    const { provider, bodies, advance } = setup(3600);
    await provider.getToken();
    advance(3_000_000); // 50 minutes
    await expect(provider.getToken()).resolves.toBe("token-1");
    advance(560_000); // inside the 60 s refresh window
    await expect(provider.getToken()).resolves.toBe("token-2");
    expect(bodies).toHaveLength(2);
  });

  it("shares one request between concurrent callers", async () => {
    const { provider, bodies } = setup();
    const tokens = await Promise.all([provider.getToken(), provider.getToken(), provider.getToken()]);
    expect(new Set(tokens)).toEqual(new Set(["token-1"]));
    expect(bodies).toHaveLength(1);
  });

  it("fetches a new token after invalidate()", async () => {
    const { provider } = setup();
    await provider.getToken();
    provider.invalidate();
    await expect(provider.getToken()).resolves.toBe("token-2");
  });
});
