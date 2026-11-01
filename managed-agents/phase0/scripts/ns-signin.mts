// Phase 0: one-time NetSuite sign-in (authorization code + PKCE, public client 209 "SuiteReact MCP (local)") for the AI Connector.
// Prints only non-secret facts. Tokens go to tokens.json (mode 600) next to this file, for the vault step.
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const host = "tstdrv1755417";
const authorizeUrl = `https://${host}.app.netsuite.com/app/login/oauth2/authorize.nl`;
const tokenUrl = `https://${host}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;
const mcpUrl = `https://${host}.suitetalk.api.netsuite.com/services/mcp/v1/all`;
const redirectUri = "http://localhost:57432/callback";
/** The NetSuite role to choose on the login page: the role of the tier being signed in (roles/tiers.json). */
const roleName = process.argv[2]?.trim() || "NS Agent Integration";
const ask = createInterface({ input: process.stdin, output: process.stdout });
const clientId = (process.env.NS_BUILDER_CLIENT_ID?.trim() || (await ask.question("Client ID of integration 209 (NETSUITE_CLIENT_ID in ~/dev/suitemcp/mcp/.env): ")).trim());
ask.close();
if (!clientId) throw new Error("no client ID given");
// 209 is a confidential client: the secret authenticates the token request (client_secret_basic). Never printed.
const clientSecret = process.env.NS_BUILDER_CLIENT_SECRET?.trim();
if (!clientSecret) throw new Error("NS_BUILDER_CLIENT_SECRET is not set");

const b64url = (b: Buffer) => b.toString("base64url");
const verifier = b64url(randomBytes(48));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16));

const url = new URL(authorizeUrl);
for (const [k, v] of Object.entries({
  response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: "mcp",
  state, code_challenge: challenge, code_challenge_method: "S256",
})) url.searchParams.set(k, v);

// Catch the redirect on 127.0.0.1:57432 (integration 209's registered callback).
const callback = new Promise<URL>((resolve, reject) => {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", redirectUri);
    if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": "text/plain" }).end("NetSuite sign-in received. You can close this tab and return to the terminal.");
    server.close();
    resolve(u);
  });
  server.on("error", reject);
  server.listen(57432, "127.0.0.1");
  setTimeout(() => { server.close(); reject(new Error("no sign-in within 10 minutes")); }, 600_000).unref();
});
console.log(`\nOpening NetSuite. Sign in with role ${roleName} and allow access.\nIf no browser opens, use this link:\n`);
console.log(url.toString());
execFile("open", [url.toString()], () => {});
const back = await callback;

if (back.searchParams.get("state") !== state) throw new Error("state does not match; start again");
const error = back.searchParams.get("error");
if (error) throw new Error(`NetSuite returned ${error}: ${back.searchParams.get("error_description") ?? ""}`);
const code = back.searchParams.get("code");
if (!code) throw new Error("no code in that address");

const res = await fetch(tokenUrl, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}` },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }),
});
const body = (await res.json()) as Record<string, unknown>;
if (!res.ok || typeof body.access_token !== "string") {
  throw new Error(`token exchange failed: HTTP ${res.status} ${String(body.error ?? "")} ${String(body.error_description ?? "")}`);
}
const issuedAt = new Date();
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "tokens.json");
writeFileSync(out, JSON.stringify({ ...body, issued_at: issuedAt.toISOString(), client_id: clientId, token_endpoint: tokenUrl, mcp_url: mcpUrl }), { mode: 0o600 });

console.log(`\nToken exchange OK. expires_in=${String(body.expires_in)} s, refresh token: ${body.refresh_token ? "yes" : "NO"}` +
  `${body.refresh_token_expires_in ? `, refresh_token_expires_in=${String(body.refresh_token_expires_in)} s` : ""}, scope=${String(body.scope ?? "?")}`);

// Read-only check: list the connector's tools with the new token.
const headers = { Authorization: `Bearer ${body.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const init = await fetch(mcpUrl, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "phase0", version: "0" } } }) });
console.log(`MCP initialize: HTTP ${init.status}`);
if (init.ok) {
  const sid = init.headers.get("mcp-session-id");
  await init.text();
  const h2 = sid ? { ...headers, "Mcp-Session-Id": sid } : headers;
  await fetch(mcpUrl, { method: "POST", headers: h2, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }).then((r) => r.text());
  const list = await fetch(mcpUrl, { method: "POST", headers: h2, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
  const text = await list.text();
  const json = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join(""));
  const names = ((json.result?.tools ?? []) as { name: string }[]).map((t) => t.name).sort();
  console.log(`MCP tools/list: ${names.length} tools; nsagent tools present: ${names.filter((n) => n.startsWith("nsagent")).join(", ") || "none"}`);
}
console.log(`\nSaved for the vault step (not printed): ${out}`);
