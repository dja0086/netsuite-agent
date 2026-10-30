# Plan: NetSuite AI Connector with Claude Code and herdr

Status: **draft, 2026-10-30.** Decision record: `docs/adr/0007-retire-gateway-use-ai-connector.md` (proposed). Nothing in this plan has been built yet.

## Goal

A finance user asks for NetSuite data or a change in plain language. Claude Code agents, run side by side in herdr, answer through Oracle's AI Connector. Every write waits for a yes at the agent's terminal and every NetSuite call is logged. The custom gateway is retired.

## Target setup

```
herdr workspace "netsuite"
 ├─ ns-data     Claude Code, "NetSuite All" connector, reads free, writes ask   ← the only NetSuite agent
 ├─ builder     Claude Code, no NetSuite tools: turns data files into Excel, decks, write-ups
 └─ reviewer    Claude Code, no NetSuite tools: checks totals, currencies, filters before you trust a result
 You (or a lead agent) hand work between panes: herdr agent prompt / wait / read.
```

- **One NetSuite agent.** The account allows 5 concurrent requests in total and there is no client-side limiter any more; parallel calls were the only 429s seen. Other agents work on files `ns-data` writes to `exports/`.
- **Writes ask.** Oracle's write tools are set to `ask` in `.claude/settings.json`, so the agent stops and herdr shows its pane as blocked until you answer.
- **Production connector denied.** "United Refractories - NetSuite" (9173162) is a real company account; it is denied in this project so no agent here can call it.
- **Audit hook.** A PostToolUse hook logs each NetSuite connector call (tool, time, ok, input hash) to `audit/connector-YYYY-MM.jsonl`.

### Connector tools by kind (from the CP4 listing)

| Kind | Tools | Policy |
| --- | --- | --- |
| Read | `ns_runCustomSuiteQL`, `runCustomSuiteQL`, `ns_getSuiteQLMetadata`, `ns_getRecord`, `ns_getRecordTypeMetadata`, `ns_listAllReports`, `ns_runReport`, `ns_listSavedSearches`, `ns_runSavedSearch`, `ns_getSubsidiaries`, `ns_getAccountingBooks`, `ns_getAccountingContexts`, `ns_getNexusIds`, `ns_getSessionInfo`, `getCustomerDetails`, `getCustomerBalance`, `getCustomerTransactions`, `searchCustomer`, `getItemDetails`, `checkInventoryLevels`, file reads (`ns_getFile`, `ns_searchFiles`, `ns_getFolderByPath`, …) | Allowed |
| Write | `createCustomer`, `updateCustomer`, `ns_createRecord`, `ns_updateRecord`, `ns_transformRecord`, `ns_executeRecordAction` | **Ask** on every call |
| File writes | `ns_uploadFile`, `ns_uploadFileApp`, `ns_attachFile`, `ns_detachFile` | **Deny** (no use case needs them) |
| Ours (to retire) | `nsagent_suiteql`, `nsagent_record_get` | Deny once the toolset is inactivated |

## Phases

Each phase ends with something you can use. No checkpoint ceremony: each has one "done when".

### Phase 1: Guardrails and first reads (1 PR)

1. `.claude/settings.json`: allow the read tools, `ask` for write tools, deny file writes and every tool of the production connector. Match by tool name suffix so the claude.ai server prefix does not matter.
2. Audit hook script (`scripts/hooks/connector-audit.sh`) and its PostToolUse entry.
3. Remove the gateway from `.mcp.json` (the code stays until Phase 4).
4. Verify, and write down the answers: how claude.ai connector tools are named in the `claude` CLI; that `ask` stops a write in a herdr pane; that the production connector is blocked; that `--strict-mcp-config` (or `--disallowedTools`) leaves `builder` and `reviewer` with no NetSuite tools.

Done when: use cases UC-01 to UC-03 run in one Claude Code session through the connector, a write attempt stops for a yes, a call to the production connector is refused, and the audit file has one line per call.

### Phase 2: herdr workspace

1. `scripts/herdr-netsuite.sh`: creates the workspace and starts the three agents with their tool limits.
2. `.claude/agents/` roles for the lead session (data, builder, reviewer), so one Claude Code session can also fan out without herdr.
3. Short `docs/herdr.md`: start, hand off, read results, stop.

Done when: UC-10 (month-end AR pack) runs across the three panes, and only `ns-data` makes NetSuite calls (checked in the audit file).

### Phase 3: Writes, on the demo account

Run UC-07 and UC-08 with test customers named `nsagent-test-*`; confirm each write asked first and was logged. Clean up test records in the NetSuite UI.

Done when: both writes needed a yes, both are in the audit file, and nothing else changed.

### Phase 4: Retire the gateway

1. Tag `gateway-final` on main.
2. Remove `apps/mcp-gateway`, the gateway-only packages (`ns-client`, `suiteql`, `report-engine`, `import-engine`, `schemas`), `skills/` gateway manifests, gateway scripts and tests, the related CI steps. Keep `netsuite/` (role, SDF), `deploy-sdf`, `packages/sdf-gen` only if a field or template change is planned (else remove too), and docs.
3. Unload the launchd job; remove gateway settings from `.env` and `.env.example`.
4. Rewrite CLAUDE.md and `docs/runbook.md` for the connector setup. ADR 0007 to accepted.
5. Owner clicks in NetSuite: revoke M2M mapping jxqM14Kc…, inactivate integration record 207, inactivate the RESTlet deployments (explore, search, PDF) and the toolset, release the concurrency slice.

Done when: `pnpm check` (or what replaces it) passes on the slimmer repo, the gateway login is revoked in NetSuite, and CLAUDE.md describes only what exists.

## Use cases (draft)

Pilot user: finance / AR (from the Request Assistant PRD). "Agent" is the herdr pane that does the step. Account names: Clients = customers, Master Contract = sales order, Vendor Invoices = bills.

| ID | Request (as a user would say it) | Agent(s) | Connector tools | Writes | Done when |
| --- | --- | --- | --- | --- | --- |
| UC-01 | "Which clients have invoices more than 60 days overdue? Top 10 by amount, per currency." | ns-data | `ns_runCustomSuiteQL` | No | Table with client, currency, amount, oldest due date; amounts never summed across currencies |
| UC-02 | "Give me everything on client Bay Media Research: balance, open invoices, last payment." | ns-data | `searchCustomer`, `getCustomerDetails`, `getCustomerBalance`, `getCustomerTransactions` | No | One summary; figures match the client record in the UI |
| UC-03 | "Is there already a saved search for open AR? Run it." | ns-data | `ns_listSavedSearches`, `ns_runSavedSearch` | No | Existing search found and run before anything new is proposed (reuse first) |
| UC-04 | "Run the standard A/R aging report for last month and give me an Excel file." | ns-data → builder | `ns_listAllReports`, `ns_runReport` | No (local file only) | `exports/ar-aging-<date>.xlsx` with the report's rows and an as-of note |
| UC-05 | "Which vendor invoices are due in the next 14 days, by subsidiary?" | ns-data | `ns_runCustomSuiteQL` | No | List with subsidiary, vendor, due date, amount, currency |
| UC-06 | "Open master contracts waiting for fulfilment, oldest first." | ns-data | `ns_runCustomSuiteQL` | No | Status codes translated (B pending fulfilment, D partially fulfilled, …) |
| UC-07 | "Create a client: Acme Test Ltd, email ap@acmetest.example, subsidiary US." | ns-data | `searchCustomer` (duplicate check), `createCustomer` | **Yes, asks** | Duplicate check shown first; create asked, then done; new internal id reported |
| UC-08 | "Change Acme Test Ltd's email to billing@acmetest.example." | ns-data | `getCustomerDetails`, `updateCustomer` | **Yes, asks** | Before and after shown; update asked, then done |
| UC-09 | "Do we have stock of item X at the main warehouse?" | ns-data | `getItemDetails`, `checkInventoryLevels` | No | On hand and available by location |
| UC-10 | "Build the month-end AR pack: aging by client, top 10 overdue, DSO trend, and a one-page summary." | ns-data → builder → reviewer | SuiteQL, `ns_runReport` | No | Data files from ns-data; workbook and summary from builder; reviewer confirms totals tie to the aging report and currencies are not mixed, or lists what does not tie |
| UC-11 | "Which saved searches and reports already cover overdue invoices? Recommend one, or what to build." | ns-data → reviewer | `ns_listSavedSearches`, `ns_listAllReports` | No | Reuse recommendation with a reason; a new build only if nothing fits |

Out of scope for now: saved-search creation (UI), deletes (UI), bulk imports (CSV Import Assistant), schema changes (SDF via PR, unchanged), the PRD's synced sheets, Slack/Teams, and the Suitelet portal.

## Decisions needed from the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Oracle write tools: `ask` on every call, or deny all writes | **Ask**: UC-07 and UC-08 need them |
| D2 | Keep SDF change control (`netsuite/`, `deploy-sdf`, role XML) | **Keep**: the connector's role must stay under review, and fields and templates still ship this way |
| D3 | Keep a daily alert on the new audit file | **No**: the log is enough for one user; revisit with more users |
| D4 | Delete gateway code from main after tagging, or leave it disabled | **Delete**: history keeps it; leaving it invites drift |
| D5 | Keep `custtoolset_nsagent_read` in NetSuite | **Inactivate**: Oracle's SuiteQL tool covers it |

## Risks

- **Unverified before Phase 1:** tool naming of claude.ai connectors in the CLI, and whether `ask` and deny rules apply to them. If they do not, a PreToolUse hook does the same job by tool-name pattern.
- **Same person requests and approves.** Acceptable for one owner on a demo account; not for a team or a real company account (ADR 0007, "Revisit if").
- **No redaction.** Anything the role can read reaches the model.
- **herdr is young** (0.9.5). If it misbehaves, the same roles run as Claude Code subagents in one session.
