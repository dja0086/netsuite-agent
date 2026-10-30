# ADR 0007: Retire the gateway; use NetSuite's AI Connector from Claude Code and herdr

**Status:** proposed · 2026-10-30 · owner request ("sunset what we built here and use the existing NetSuite connector/MCP"; "stick with Claude Code and herdr"). Supersedes ADRs 0001, 0003, 0004, 0005 and 0006 once accepted. ADR 0002 (SDF-only schema changes) stays.

## Decision

1. **NetSuite access goes through Oracle's AI Connector only**: the claude.ai custom connector "NetSuite All" (`/services/mcp/v1/all`), signed in as NS Agent Integration. Claude Code sessions, including every agent herdr starts, reach it through the claude.ai account.
2. **The gateway is retired**: `apps/mcp-gateway`, the packages only it uses, its skills, the M2M login and the RESTlets and toolset that only it calls. Code stays in git history under the tag `gateway-final`.
3. **Controls move into Claude Code**, in this repo's `.claude/` config:
   - Oracle's write tools need a yes from the person at the agent's terminal on every call (permission `ask`), or are denied.
   - The production account's connector ("United Refractories - NetSuite", 9173162) is denied in this project.
   - A hook appends one JSON line per NetSuite tool call to `audit/connector-YYYY-MM.jsonl`: tool, time, outcome, input hash. No inputs or results.
4. **Orchestration is herdr**: several Claude Code agents in one workspace, only one of which has NetSuite access at a time.
5. **Kept**: the role `customrole_ns_agent` (the connector needs it), the SDF project and `deploy-sdf` for account changes (ADR 0002), and the docs as history.

## Why

- Oracle's connector already offers what most requests need: SuiteQL, record reads, reports, saved searches, customer details and balances, inventory levels, customer create and update. CP4 confirmed it serves our role, and that its answers match the gateway (5/5).
- The gateway's extra value was control (approvals bound to the payload, redaction, the concurrency limiter, audit). Most of that can be approximated in Claude Code config at a fraction of the upkeep; the rest is accepted as lost (below).
- One NetSuite surface instead of two removes the "which `ns_` tool is ours" confusion and the second login.

## What is lost (accepted)

| Gateway capability | After | Accepted because |
| --- | --- | --- |
| Approval bound to the exact payload, named approver, replay-proof, 15-minute expiry (ADR 0004) | Claude Code asks the person at the terminal before each write call; they see the arguments. Not bound, not separate from the requester. | Single-owner use on a demo account |
| Saved-search creation (`ns_search_save`) | No connector tool creates saved searches; build them in the NetSuite UI | Rare; UI is fine |
| Customer import with full dry run and file hash (ADR 0005) | `createCustomer` one record at a time, each asked | Small volumes only; large imports use NetSuite's CSV Import Assistant |
| Approved deletes (ADR 0006) | No connector delete tool; delete in the UI | Rare |
| Redaction of tax and bank ids | None: the connector returns what the role can see | Role permissions are the control; demo data |
| Concurrency limiter (2 slots) | None in the client. herdr layout keeps one NetSuite agent; agents call tools one at a time | Account limit is 5; parallel bursts were the only 429s seen |
| Report exports (`ns_report_run` to CSV/XLSX) | Claude Code writes the file from query results (xlsx skill) | Same outcome, less code |
| Contract tests, tool evals, load test, `release:check`, daily alerts | Use-case walkthroughs (`docs/connector-herdr-plan.md`) and the audit hook | Nothing left to regression-test in our code |

## Consequences

- Owner clicks in NetSuite (not SDF; SDF cannot delete): revoke the M2M certificate mapping jxqM14Kc…, inactivate integration record 207 "NS Agent Gateway", inactivate the three RESTlet deployments and the toolset `custtoolset_nsagent_read`, and release the integration's concurrency slice.
- The launchd audit job is unloaded; `NS_*` gateway settings leave `.env`.
- CLAUDE.md and `docs/runbook.md` are rewritten for the connector.
- Revisit if: several people use it (approvals would need to be separate from the requester again), it moves to a real company account, or bulk writes are needed.
