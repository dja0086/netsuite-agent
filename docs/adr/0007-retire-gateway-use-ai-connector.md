# ADR 0007: Retire the gateway; NetSuite agents run as Claude Managed Agents on the AI Connector

**Status:** accepted · 2026-10-31 by the owner (first draft 2026-10-30) · owner requests: "sunset what we built here and use the existing NetSuite connector/MCP"; "a GUI for managed agents: I tell you my use case and it'll build". Supersedes ADRs 0001, 0003, 0004, 0005 and 0006 once accepted. ADR 0002 (SDF-only schema changes) stays. Evidence: `docs/phase0-managed-agents.md`.

**Implemented 2026-10-31:** the repo side is done (tag `gateway-final` on 91602c0, then the gateway, its packages, skills, scripts, contract tests and the three RESTlets removed; the toolset stays because builder agents use it). The daily audit job was unloaded. Still due: the owner's NetSuite clicks under "Consequences".

## Decision

1. **NetSuite access goes through Oracle's AI Connector only** (`/services/mcp/v1/all`), signed in as NS Agent Integration through integration 209. The OAuth token lives in a Claude Managed Agents vault and renews there (Phase 0).
2. **Agents are Claude Managed Agents**, one per use case, created by an agent builder (`docs/agent-builder-plan.md`) rather than written by hand. No use case is hardcoded.
3. **Controls live in each agent's configuration**, enforced by Managed Agents, and the builder refuses any configuration that breaks them:
   - NetSuite read tools `always_allow`; write tools `always_ask` (a person approves each call and sees its exact input); file-write tools disabled; any tool not listed `always_ask`.
   - The only MCP server allowed is the demo account's `/all` URL. The production account (9173162) cannot be configured.
   - Environments use `limited` networking with MCP servers only, unless a use case needs more and the owner approves it.
   - The record of each run is the session's event history (every tool call, its permission decision and result).
4. **The gateway is retired** once the builder's first version works: `apps/mcp-gateway`, the packages only it uses, its skills, the M2M login (integration 207), and the RESTlets and toolset only it calls. Code stays in git history under the tag `gateway-final`.
5. **Kept:** the role `customrole_ns_agent`, the SDF project and `deploy-sdf` for account changes (ADR 0002), and the docs as history.

## Why

- Phase 0 showed the whole path works without our code: reads, an approved write, and token renewal, with the agent running on Anthropic's side.
- Oracle's connector covers most requests (SuiteQL, record reads, reports, saved searches, customer details and balances, inventory, customer create and update). CP4 confirmed it serves our role and matches the gateway (5/5).
- Managed Agents supplies what the gateway built by hand: per-tool approval, credential storage that the agent cannot read, versioned agent configs, schedules, and a session viewer.

## What is lost (accepted)

| Gateway capability | After | Accepted because |
| --- | --- | --- |
| Approval bound to the exact payload hash, named approver, replay-proof, 15-minute expiry (ADR 0004) | Per-call Approve/Deny on the paused tool call, showing its exact input; whoever operates the session decides | Single-owner use on a demo account |
| Saved-search creation (`ns_search_save`) | No connector tool creates saved searches; build them in the UI | Rare |
| Customer import with full dry run bound to the file hash (ADR 0005) | `createCustomer` per record, each approved | Small volumes; bulk imports use NetSuite's CSV Import Assistant |
| Approved deletes (ADR 0006) | No connector delete tool; delete in the UI | Rare |
| Redaction of tax and bank ids | None: results contain what the role can read | Role permissions are the control; demo data |
| Concurrency limiter | None client-side; the account allows 5 concurrent requests | To be checked under several sessions (Phase 0, "Not tested") |
| Audit log, retention and daily alerts (CP5) | Session event history in Anthropic's Console | Retention on Anthropic's side not yet checked |

## Consequences

- Integration 209 is AI Connector only; suitemcp can no longer sign in through it (owner's decision 2026-10-31).
- The vault's NetSuite sign-in may need repeating weekly (209's 168-hour token rotation limit); to be confirmed 2026-11-06/07.
- When the gateway is retired, the owner (in NetSuite, not SDF): revokes the M2M mapping jxqM14Kc…, inactivates integration 207, inactivates the three RESTlet deployments and the toolset `custtoolset_nsagent_read` (or keeps the toolset; the connector serves it), and releases 207's concurrency slice. The launchd audit job is unloaded. CLAUDE.md and `docs/runbook.md` are rewritten.
- Revisit if several people use it (approvals would need to be separate from the requester again), if it moves to a real company account, or if bulk writes are needed.
