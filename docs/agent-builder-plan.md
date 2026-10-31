# Plan: NetSuite agent builder on Claude Managed Agents

Status: **Phase 1 done 2026-10-31; Phase 2 next, then gateway retirement.** Decision record: `docs/adr/0007-retire-gateway-use-ai-connector.md` (accepted 2026-10-31). Phase 0 passed (`docs/phase0-managed-agents.md`). Nothing below is built yet. Replaces the Claude Code + herdr plan of 2026-10-30.

## Goal

The owner describes a NetSuite use case in plain language ("every Monday, clients more than 60 days overdue, as Excel, by currency"). The builder turns it into a Claude Managed Agent connected to NetSuite's AI Connector, with the safety rules applied, and the owner can run it, approve its writes and get its files. Use cases are inputs, not code.

## How it works

```
 Use case (plain language)
   │
   ▼
 1 Draft   Claude (Messages API, structured output) proposes an agent spec:
           name, instructions, NetSuite tools needed, output files (xlsx/pdf skill),
           run shape (on demand / schedule / one deliverable with a checklist)
 2 Check   fixed rules in code (below); a spec that breaks one is rejected, not repaired silently
 3 Edit    the owner adjusts the spec in a form
 4 Create  agent + (schedule) through the Managed Agents API; reuses the shared
           environment and the NetSuite vault from Phase 0
 5 Run     session view: live output, Approve / Deny on paused writes, files to download
 6 Library agents, versions, past runs
```

### Fixed rules (enforced by the builder, not the model)

1. The only MCP server is `https://tstdrv1755417.suitetalk.api.netsuite.com/services/mcp/v1/all`.
2. NetSuite write tools (`createCustomer`, `updateCustomer`, `ns_createRecord`, `ns_updateRecord`, `ns_transformRecord`, `ns_executeRecordAction`) are `always_ask`. File-write tools (`ns_uploadFile`, `ns_uploadFileApp`, `ns_attachFile`, `ns_detachFile`) are disabled. The toolset default is `always_ask`, so a tool Oracle adds later asks first.
3. Read tools may be `always_allow`, chosen per use case from the connector's read tools.
4. Sandbox tools (bash, files) only when the use case produces files; web search and web fetch off.
5. Environment: `limited` networking, MCP servers only. Anything more needs the owner's explicit OK in the form.
6. Every session gets a spend limit.

## Phases

### Phase 1: builder MVP (create agents)

Steps 1–4 above, as a small local web app (TypeScript, matching this repo). Runs happen in Anthropic's Console session viewer for now.

Done when: three use cases typed in plain language (one read-only, one with an Excel file, one with an approved write) each become an agent that passes the fixed rules and runs correctly from the Console.

**Phase 1 result (2026-10-31): done.** `apps/agent-builder` (`pnpm builder`, http://127.0.0.1:5178): describe, draft (Claude Opus 5.5, structured output), check, edit, create, start a run with the shared environment, NetSuite vault and a $5 cap. Rules: `src/rules.ts` (12 tests). The three use cases, each typed in plain language:

| Use case | Agent | Run | Outcome |
| --- | --- | --- | --- |
| Top 10 clients by open balance, per currency (read-only) | `agent_01PzebKcnozyhx7Ssf2wTGSq` | `sesn_01PsL7NyrcU527KNCANWM9P9` | Correct per-currency tables. Paused once on `nsagent_suiteql` (not in its tool list, so it asked); the owner allowed it. Drafting now always adds `nsagent_suiteql` as a fallback. |
| Weekly 60+ days overdue as Excel, one sheet per currency | `agent_019ZUHCPhGfVppkUm7MepH2K` | `sesn_01JhBM36YFAAKqH6zW7tHmk9` | `Overdue_60plus_2026-10-31.xlsx`: 499 invoices, totals per currency, cross-checked by a second query; no pauses. |
| Change a client's email (approved write) | `agent_011H4qxHjZZXkRii1KP2CPsU` | `sesn_01BmSpnG3E4CcyLDrWB87L37` | Draft asked for `updateCustomer` and `ns_updateRecord`; the owner kept only `updateCustomer`. Paused on `updateCustomer` for client 2928; the owner allowed it; the gateway confirms the new email. |

Findings: Oracle's `ns_runCustomSuiteQL` fails with "An unexpected SuiteScript error" on some queries (grouping by `BUILTIN.DF`); drafting guidance now warns against it. Approvals were sent with `ant` after the owner's word; Phase 2 brings Approve/Deny into the builder.

### Phase 2: runs and approvals in the builder

Step 5: start a run, stream its events, Approve / Deny paused writes, download files.

Done when: the Phase 1 use cases run end to end without opening the Console.

### Phase 3: library and schedules

Step 6, plus scheduled agents and a way for a scheduled run that is waiting on an approval to reach the owner.

Done when: a weekly agent runs on schedule and a pending approval reaches the owner.

### Retire the gateway (after Phase 1)

As in ADR 0007, "Consequences": tag `gateway-final`, remove gateway code, owner's NetSuite clicks, rewrite CLAUDE.md and the runbook.

## Open items

- **168-hour limit:** check on 2026-11-06/07 whether the vault still reaches NetSuite. If not, Phase 1 includes a "Reconnect NetSuite" button that re-runs the sign-in and updates the vault credential.
- **Clean up Phase 0:** test client 2928.
- **Concurrency:** several sessions at once against the account's 5 concurrent requests; measure before enabling schedules.
- **Event retention** on Anthropic's side, to replace the CP5 audit retention.

## Owner decisions (2026-10-31)

| # | Decision | Decided |
| --- | --- | --- |
| D1 | Where the builder runs | Local web app on the owner's Mac; hosting is a later decision |
| D2 | Who uses it | Owner only; multi-user needs separate approvers again (ADR 0007, "Revisit if") |
| D3 | When to retire the gateway | After Phase 1 is done |
