# Phase 0: a Managed Agent on NetSuite's AI Connector

Status: **passed 2026-10-31**, with one item open (the 168-hour limit, below). Run 2026-10-30/31 on demo (pilot) account.

Question: can a Claude Managed Agent use Oracle's AI Connector (`/services/mcp/v1/all`) directly, with a NetSuite OAuth token held in a Managed Agents vault: no gateway, no process on the owner's Mac?

## Result

| Check | Result | Evidence |
| --- | --- | --- |
| Agent reaches NetSuite through the vault | Pass | Read session below |
| Runs as NS Agent Integration | Pass | `ns_getSessionInfo`: the pilot account, role `customrole_ns_agent` |
| Read tools run without asking | Pass | 3 calls, `evaluated_permission: allow`; 1,014 clients, invoice status A 504 / B 601 (same as CP4) |
| Write tools stop for approval, then run once | Pass | `createCustomer` paused (`requires_action`); after the owner's Allow it created the test client, confirmed by a separate gateway read |
| Vault renews the expired access token | Pass | Session started 2026-10-31 17:30 UTC, ~20 h after the first access token expired (2026-10-30 21:43 UTC); it reached NetSuite as `customrole_ns_agent` |
| Token use beyond 168 hours | **Open** | The AI Connector integration shows Refresh token validity 168 h and Maximum time for token rotation 168 h. Whether the vault keeps working after 2026-11-06 ~20:40 UTC (168 h after sign-in) is not yet known; if not, the owner signs in again weekly. |

## What was set up

**NetSuite (owner's clicks):** the integration "SuiteReact MCP (local)" changed to the AI Connector only, because NetSuite requires that scope to stand alone:
- NetSuite AI Connector Service ticked; RESTlets, REST Web Services and SuiteAnalytics Connect cleared.
- Authorization Code Grant ticked; Client Credentials (M2M), Token-based Authentication and User Credentials cleared.
- Public Client off (confidential client; the vault renews with its client secret, `client_secret_basic`).
- Redirect URI `http://localhost:57432/callback`; refresh token validity and rotation limit 168 h.

Side effect: the local suitereact-mcp server (`dja0086/suitereact-mcp`, checked out at `~/dev/suitemcp`), which signed in through that integration with `restlets rest_webservices`, can no longer sign in through it. The gateway integration (gateway, M2M) is unchanged; its tokens are rejected by the AI Connector ("Invalid login attempt"), so it could not be reused.

**Anthropic (workspace "Default"),** defined in `managed-agents/phase0/` and created with `ant apply` (IDs in `claude-lock.json`):

| Resource | ID | Settings |
| --- | --- | --- |
| Agent "NetSuite Phase 0" | `agent_…` (v1) | Claude Opus 5.5; MCP server `netsuite` = the `/all` URL; no sandbox tools; NetSuite tools: 13 reads `always_allow`, 6 writes `always_ask`, 4 file writes disabled, anything else `always_ask` |
| Environment `netsuite-phase0-env` | `env_…` | cloud, `limited` networking, MCP servers only |
| Vault | `vlt_…` | One `mcp_oauth` credential `vcrd_…` for the `/all` URL, with refresh (token endpoint, the AI Connector integration, `client_secret_basic`) |

## How the token got into the vault

1. `managed-agents/phase0/scripts/ns-signin.mts`: authorization code + PKCE against the AI Connector integration, scope `mcp`, callback caught on `localhost:57432`. It saves the token response to a mode-600 file and prints only facts (lifetime, refresh token present, tool count). Result: access token 3,600 s, refresh token present, 45 tools including `nsagent_suiteql` and `nsagent_record_get`.
2. `managed-agents/phase0/scripts/vault-store.mts`: sends the tokens and client secret to `ant beta:vaults:credentials create` on stdin (never on the command line or in a file), prints only the credential ID.
3. The local token file was deleted; the vault holds the only copy.

Client ID and secret are read at run time from `NS_BUILDER_CLIENT_ID` / `NS_BUILDER_CLIENT_SECRET` (for this run, from suitemcp's `mcp/.env`). Nothing secret is in the repo.

## Sessions

| Session | What | Outcome |
| --- | --- | --- |
| `sesn_…` | Read test: session info, client count, invoice status counts | 3 reads, all allowed, no errors |
| `sesn_…` | Write test: duplicate check, then create client `nsagent-phase0-test-001` | Paused on `createCustomer` (`{"companyname":"nsagent-phase0-test-001","email":"phase0-test@example.com","isperson":"F","subsidiary":"<subsidiary id>"}`); owner allowed; the test client created |
| `sesn_…` | Renewal test, ~20 h after first token expiry | Reached NetSuite as `customrole_ns_agent` |

## Left behind

- Test client `nsagent-phase0-test-001` on the demo account (delete through the gateway's approved delete, or in the UI).
- The AI Connector integration is AI Connector only (above).
- The three Anthropic resources above.

## Not tested in Phase 0

- Use beyond 168 hours (above). Check on 2026-11-06/07; if it fails, re-run the sign-in and update the vault credential (`ant beta:vaults:credentials update`).
- Session event retention on Anthropic's side, and how a scheduled (unattended) run surfaces a pending approval.
- Concurrency under several sessions at once (the account allows 5 concurrent requests; there is no client-side limiter).
