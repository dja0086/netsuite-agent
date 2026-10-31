// Phase 0: put the NetSuite tokens from tokens.json into the Phase 0 vault as an mcp_oauth credential
// with refresh (client_secret_basic, integration 209). Prints only the credential id. Secrets go to `ant` on stdin.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const vaultId = process.argv[2];
if (!vaultId?.startsWith("vlt_")) throw new Error("usage: vault-store.mts <vlt_...>");
const clientSecret = process.env.NS_BUILDER_CLIENT_SECRET?.trim();
if (!clientSecret) throw new Error("NS_BUILDER_CLIENT_SECRET is not set");

const t = JSON.parse(readFileSync(path.join(here, "tokens.json"), "utf8")) as Record<string, string | number>;
if (!t.refresh_token) throw new Error("tokens.json has no refresh_token");
const expiresAt = new Date(Date.parse(String(t.issued_at)) + Number(t.expires_in) * 1000).toISOString();

const auth = {
  type: "mcp_oauth",
  mcp_server_url: t.mcp_url,
  access_token: t.access_token,
  expires_at: expiresAt,
  refresh: {
    refresh_token: t.refresh_token,
    client_id: t.client_id,
    token_endpoint: t.token_endpoint,
    token_endpoint_auth: { type: "client_secret_basic", client_secret: clientSecret },
  },
};
// Full request body on stdin: secrets never touch the command line or a file.
const body = JSON.stringify({ display_name: "NetSuite AI Connector (integration 209, NS Agent Integration)", auth });
const id = execFileSync("ant", ["beta:vaults:credentials", "create", "--vault-id", vaultId, "--transform", "id", "-r"], {
  encoding: "utf8",
  input: body,
}).trim();
console.log(`Vault credential created: ${id} (access token expires ${expiresAt}; renews via refresh token)`);
