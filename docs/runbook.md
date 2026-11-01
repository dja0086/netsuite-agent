# Operations runbook

How to run, watch and fix the NetSuite agents in day-to-day use. Since 2026-10-31 (ADR 0007) every agent is a Claude Managed Agent made by the agent builder; the MCP gateway is retired (code under the tag `gateway-final`). Using the builder: `docs/agent-builder.md`. Account deploys: `docs/release.md`. The role and its review: `docs/netsuite-role.md`.

## On call

| Role | Who | Reached by |
| --- | --- | --- |
| On-call owner | dja0086 (Dominick Amirr) | GitHub notifications on dja0086/netsuite-agent (waiting-run issues) |
| NetSuite admin | dja0086 | same |

Owner decision 2026-10-30. When the team grows, name a backup here.

## What runs where

| Part | Where | Runs as | Record |
| --- | --- | --- | --- |
| Agent builder (`pnpm builder`, http://127.0.0.1:5178) | The owner's Mac, on demand | The owner's `ant` login | `apps/agent-builder/data/` (agents, runs, schedules; git-ignored) |
| Agents and their runs | Anthropic (Claude Managed Agents), shared environment and NetSuite vault from `managed-agents/phase0/claude-lock.json` | Each run's NetSuite calls use the vault's token: employee 2815 with role NS Agent Integration, through integration 209 | The session's event history: every tool call, its approval decision and result (builder run page, or the Claude Console) |
| Schedules | Anthropic deployments (cron + time zone), listed on the builder's Schedules page | As above | Each scheduled run is a session like any other |
| Waiting-run check (`apps/agent-builder/scripts/pending-check.sh`) | The owner's Mac, launchd `com.dja0086.netsuite-agent.builder-pending`, every 15 minutes | The owner's `ant` and `gh` logins | `~/Library/Logs/netsuite-agent-builder-pending.log` |
| NetSuite AI Connector | `https://tstdrv1755417.suitetalk.api.netsuite.com/services/mcp/v1/all` | The signed-in role | Login Audit Trail; the toolset's script execution log |
| Role, toolset, custom field, PDF template | NetSuite TSTDRV1755417, deployed by `deploy-sdf` | | NetSuite script execution logs |

## Approvals

Every NetSuite write an agent attempts (`createCustomer`, `updateCustomer`, `ns_createRecord`, `ns_updateRecord`, `ns_transformRecord`, `ns_executeRecordAction`) stops the run until someone decides on the run page, which shows the exact request. File writes and Oracle's UI tools are disabled; any tool not on an agent's list also asks. The builder refuses a configuration that breaks these rules (`apps/agent-builder/src/rules.ts`, checked again before anything is sent).

Approve only a request you have read on the run page. A denial with a reason tells the agent no and it carries on.

## When a waiting-run issue opens

The issue ("NetSuite agent waiting for approval: <agent>") names the agent and the run only; the repo is public.

1. Start the builder (`pnpm builder`) and open **For you**, or the run id from the issue under **Runs**. If the page says it is out of date, reload it.
2. Read the exact request and Approve or Deny.
3. Check the outcome on the run page (the agent re-reads what it changed), then close the issue.

If nothing seems to happen after a click: the builder may have stopped (the desktop app stops preview servers); restart it and reload the page.

## When a run fails

Read the run page: the stop note and the last tool result say why.

- **NetSuite sign-in errors** (401, `invalid_grant`, the MCP server failing to connect): the vault's NetSuite token can no longer refresh. Sign in again: `managed-agents/phase0/scripts/ns-signin.mts`, then update the vault credential (`ant beta:vaults:credentials update`; steps in `docs/phase0-managed-agents.md`). Debug in NetSuite: Setup > Users/Roles > View Login Audit Trail, filtered on the OAuth application "SuiteReact MCP (local)" (the connector's role cannot query `loginaudit` with SuiteQL).
- **Permission errors**: a role change. Compare the account with `customrole_ns_agent.xml` (`suitecloud object:import`, review the diff).
- **Query errors on `ns_runCustomSuiteQL` / `nsagent_suiteql`**: usually a bad query. If they cluster on one shape, check NetSuite release notes for SuiteQL changes, and the builder's drafting guidance (`apps/agent-builder/src/draft.ts`).
- **Budget reached**: each run is capped at $5. Narrow the agent's instructions, or raise the cap in `apps/agent-builder/src/run.ts` (owner decision).
- **Throttling** (429, concurrency errors): several runs at once against the account's 5 concurrent requests. Spread the schedules out.

## Audit and retention

- The record of each run is its session event history on Anthropic's side. How long Anthropic keeps it is not yet checked (open item in `docs/agent-builder-plan.md`).
- The retired gateway's audit log (`audit/gateway-2026-10.jsonl`) and approvals record (`audit/approvals*.sqlite`) stay on the owner's Mac, git-ignored, as history. The 365-day retention agreed at CP5 still applies: delete `gateway-2026-10.jsonl` after 2026-10-31 + 365 days by hand (`pnpm audit:prune` went with the gateway).
- Redaction of tax and bank ids (CP5) went with the gateway (ADR 0007, "What is lost"): agents see what the role can read.

## Credentials and expiry

| Item | Where | Expires / rotate |
| --- | --- | --- |
| NetSuite token for agents | Managed Agents vault (credential refreshed by Anthropic with integration 209's client secret) | Refresh token 168 h; whether the vault keeps renewing past that is checked 2026-11-06/07. If not, sign in again weekly (above). |
| `ant` login (owner) | `~/.config/anthropic` | Renews itself; `ant auth login` if the builder reports auth errors |
| CI deploy certificate | `~/.netsuite-agent/sdf-ci/`, GitHub secret `NS_PROD_SDF_PRIVATE_KEY` in environment `production` | 2027-10-23; rotate a month earlier |
| `gh` login (dja0086) | macOS keychain | Waiting-run issues stop if it lapses |

## Things never to do

- Never call Oracle's write tools from Claude Code or the claude.ai "NetSuite All" connector directly: writes go only through a builder agent's approval. Disconnect "NetSuite All" in claude.ai when you are not using it.
- Never sign in to "United Refractories - NetSuite" (account 9173162, a real production account) from this project.

## NetSuite releases

Twice a year, when TSTDRV1755417 moves to a new release: read the release notes for SuiteQL and AI Connector changes, then start a run of each agent on the builder's Agents page and compare with its last good run.

## Quarterly

- Permission review of `customrole_ns_agent` and employee 2815's global permissions (`docs/netsuite-role.md`; next 2027-01-30).
- Close or act on any open waiting-run issues.
- Check the expiry table above.
