# Plan: NetSuite agent builder on Claude Managed Agents

Status: **Phases 1, 2 and 3 done 2026-10-31; the gateway is retired in the repo (tag `gateway-final`), the owner's NetSuite clicks are still due.** The weekly agent's first scheduled run is due 2026-11-02. Decision record: `docs/adr/0007-retire-gateway-use-ai-connector.md` (accepted 2026-10-31). Phase 0 passed (`docs/phase0-managed-agents.md`). How to use the builder: `docs/agent-builder.md`. Replaces the Claude Code + herdr plan of 2026-10-30.

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

**Phase 2 result (2026-10-31): done.** The builder's run view replaces the Console: live log (agent messages, NetSuite and sandbox tool calls with input and result, errors), status and stop reason, an approval card showing the exact request with Approve / Deny and an optional reason, file downloads, follow-up messages, and a list of recent runs. The server only accepts a decision for a call that is pending now, and only serves files of runs this builder started. Logic in `src/runs.ts` (7 tests). The three use cases, re-run with the owner clicking in the builder:

| Use case | Run | Outcome |
| --- | --- | --- |
| Weekly 60+ overdue as Excel | `sesn_015zNf3vcxKnsZ1YXfXFGCcJ` | Finished with no pauses; the `.xlsx` (37,871 bytes) downloads from the page; the same request without the page token is refused (403). |
| Change a client's email | `sesn_0147LpAYq3TSecPPGsYiupG3` | Paused on `updateCustomer`; the owner clicked Approve; the session records `allow` and the gateway confirms the new email on client 2928. |
| Top 10 clients by balance | `sesn_01K7cGs7j2itFMRhZZM3XUUK` | This agent predates the `nsagent_suiteql` fallback, so each such call asked. The owner approved one and denied the next; the agent continued with its allowed tools and finished with the same figures as Phase 1. |

Lesson: the first Approve went to a page the owner could not see (the browser pane was hidden). A page left open across a builder restart now says to reload instead of failing with "forbidden".

### Phase 3: library and schedules

Step 6, plus scheduled agents and a way for a scheduled run that is waiting on an approval to reach the owner.

Done when: a weekly agent runs on schedule and a pending approval reaches the owner.

**Phase 3 result (2026-10-31): done, with one check still due.**

- **Library:** Edit opens an agent's spec in the same editor as a draft; Save as new version updates the agent (`agents.update` with the current version, so a stale edit is refused) and moves its schedules to the new version.
- **Schedules:** Managed Agents deployments with a cron schedule and time zone, each pinned to the agent's version, with the shared environment, the NetSuite vault and the $5 run cap. The Schedules page shows next and last runs and has Run now, Pause / Resume and Stop (archive). Logic in `src/schedules.ts` (5 tests with `src/pending.ts`).
- **Waiting runs reach the owner:** For you lists every run paused on an approval. A launchd job (`com.dja0086.netsuite-agent.builder-pending`, every 15 minutes, `src/pending-check.ts`) opens one GitHub issue per waiting run on dja0086/netsuite-agent naming only the agent and the run, since the repo is public.
- **Design:** the UI follows the owner's Project Tracker design packet v3 (minimal tokens, left rail, one page title in the header, one primary action per card). Only the design system was used; the packet's sample content has real names and was not copied.

| Check | Evidence | Outcome |
| --- | --- | --- |
| A scheduled run fires | Test schedule `depl_01WsnTWQyFDv2nPhu7FqTjm1` (`10 15 31 10 *`, America/New_York) started session `sesn_01EHP75BhA2jmpgE6zJ6Stik` at 19:17:44Z (Anthropic's jitter) | Ran unattended, paused on `updateCustomer` (client 2928, new email) |
| The waiting approval reaches the owner | The launchd check at 19:32:25Z opened issue #29 on its own | Issue named the agent and run only |
| The owner decides | Owner approved in the builder (after the fix below); the session records `allow` | Agent changed the email and re-read it; gateway SuiteQL shows `phase3-test@example.com` on client 2928. Issue #29 closed, test schedule paused |
| A weekly agent on schedule | `depl_01K2Wncj1g3LdEPQSnKrm5TE` "Weekly 60+ days overdue clients", `0 8 * * 1` America/New_York | **Due 2026-11-02 08:00**; check its run and workbook then |

Lessons:

- The owner's first Approve clicks did not arrive, twice: once the desktop app had stopped the builder server, once the run page was drawn over. The For you view waits on the waiting-run check, which asks Anthropic about every recent run; opening a run before that finished let the slower view draw over the run. Every view now draws only if no newer page was opened since it started.
- The waiting check costs one session read plus one event list per run from the last 14 days, so For you gets slower as runs pile up.

### Retire the gateway (after Phase 1)

As in ADR 0007, "Consequences": tag `gateway-final`, remove gateway code, owner's NetSuite clicks, rewrite CLAUDE.md and the runbook.

**Result (2026-10-31): repo side done.**

- Tag `gateway-final` on 91602c0 (pushed). Removed: `apps/mcp-gateway`, `packages/*` (ns-client, suiteql, report-engine, import-engine, sdf-gen, schemas), `skills/`, the gateway scripts (ns:ping, evals, load test, release check, approvals, audit), contract and script tests, `.mcp.json`, the skills-eval workflow, and the explore, search and PDF RESTlets with their shared libraries.
- Kept: the toolset `custtoolset_nsagent_read` and its guard tests (builder agents use `nsagent_suiteql`), the role, the field and template objects, `deploy-sdf`, `sdf-check`, and the docs as history.
- Rewritten: CLAUDE.md, `docs/runbook.md`, README, doctor (now checks `ant`, its login, `gh`, the vault lock file and the waiting-run job), `.env.example`, CODEOWNERS, CI.
- The daily audit job is unloaded; its plist is in `~/Library/LaunchAgents/retired/`. The local `audit/` folder stays as history.
- Claude Code now checks NetSuite data through the claude.ai "NetSuite All" connector's read tools (verified: client 2928 read back).
- The three RESTlets are off through SDF (#32; deploy run 41309201952, 2026-11-01): scripts inactive, deployments `customdeploy_ns_agent_explore_rl`, `customdeploy_ns_agent_search_rl`, `customdeploy_ns_agent_pdf_rl` not deployed (checked with SuiteQL).
- Revoking M2M mapping jxqM14Kc… and inactivating integration 207 "NS Agent Gateway" are the owner's to do and are not tracked here (owner decision 2026-11-01).

## Open items

- **168-hour limit:** check on 2026-11-06/07 whether the vault still reaches NetSuite. If not, Phase 1 includes a "Reconnect NetSuite" button that re-runs the sign-in and updates the vault credential.
- **Clean up Phase 0:** test client 2928 (no connector delete tool: delete it in the UI, or keep it).
- **Concurrency:** several sessions at once against the account's 5 concurrent requests. Not measured yet; schedules are enabled for one weekly agent only, so measure before adding more.
- **Event retention** on Anthropic's side, to replace the CP5 audit retention.

## Owner decisions (2026-10-31)

| # | Decision | Decided |
| --- | --- | --- |
| D1 | Where the builder runs | Local web app on the owner's Mac; hosting is a later decision |
| D2 | Who uses it | Owner only; multi-user needs separate approvers again (ADR 0007, "Revisit if") |
| D3 | When to retire the gateway | After Phase 1 is done |
