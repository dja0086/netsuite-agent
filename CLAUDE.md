# netsuite-agent: notes for Claude Code

MCP gateway + SuiteCloud project + agent skills that let an AI agent search, report on and (later, with approval) change NetSuite data. Design and delivery plan live in the "NetSuite Agent Monorepo" doc (Architecture & design, Delivery plan tabs). Current phase: **CP1 passed (2026-10-21); Phase 2 done; CP3 (approved record imports) delivered for customers**.

## Start of every session

1. Run `node scripts/doctor.mjs` and read every FAIL and WARN. Verify, never assume: if a tool is missing, stop and tell the user what to install (doctor prints the fix); do not install system software (JDK, Homebrew packages, global npm CLIs) without asking.
2. `git status` and `git log --oneline -5` to see where work stopped.
3. Read "Handoff state" below, then continue at the first unchecked item in "Next work".
4. Before live commands: `set -a; source .env; set +a`.

## Handoff state (2026-10-20)

- Repo: Phase 1, release tooling and doctor are committed; `pnpm check` passes (87 tests); delivered to `~/dev/netsuite-agent` without `node_modules` (run `pnpm install` first).
- NetSuite account TSTDRV1755417 (demo): OAuth 2.0, REST Web Services, Server SuiteScript and SDF already enabled. CP0 auth done (see below).
- CP1 (2026-10-20, branch `cp1-read-only`, no git remote yet so no PR): SDF auth ID `nsagent-demo` (Administrator @ TSTDRV1755417). The first `account:setup` linked production account 9173162 by mistake and was removed: always run `suitecloud account:manageauth --info nsagent-demo` and confirm the Account ID before any SDF deploy. Role imported, explore RESTlet deployed, `ns:ping` passes all 4 steps. Web Services Only was turned off on the role (it blocks OAuth 2.0 RESTlet logins with InsufficientPermissions); the role can now log in to the UI. DECIDED 2026-10-21 by the user: keep employee 2815 "Integration User" as the agent's integration user (it is the account's user for this use case); no dedicated "NS Agent" employee. Open: NetSuite added Other Addresses = Full to the role on deploy (docs/netsuite-role.md). Fixtures recorded (`658a44d`). `pnpm release:check` PASSED on clean commit 658a44d: release-reports/2026-10-21T00-35-07-849Z/summary.json (evals 7/7, load test 40/40 at concurrency 2, no throttling). Contract findings: SuiteQL returns values as strings; record GET with `fields` omits `id`.
- After CP1 (2026-10-20): repo on GitHub, private: dja-cowboyallstar/netsuite-agent (PRs #1-#4 merged). GitHub Actions never starts runs and the owner's public profile 404s (account likely restricted; owner to contact GitHub Support), so run `pnpm check` and gitleaks (`docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:latest detect --source /repo --redact --no-banner`, needs `colima start`) locally before merging. Other Addresses = Full is forced by NetSuite on every role save (documented in docs/netsuite-role.md). `.mcp.json` starts the gateway for Claude Code. CP1 step 8 agent cases tried by hand: both pass (docs/cp1-agent-trials.md). NetSuite UI follow-ups done 2026-10-21: mapping C96V3… revoked; the 2815 mapping (jxqM14Kc…) stays active by decision.
- Phase 2 (2026-10-21): step 9 done (PR #9): `StoredApprovals` per ADR 0004 replaces `DenyAllApprovals` when `NS_AGENT_APPROVERS` is set (demo/sandbox only); approvals in `audit/approvals.sqlite`; decide with `pnpm approvals list|show|approve|deny`. Step 10 started (PRs #10, #11): search-builder 0.1.0 **disabled**, `ns_search_preview` + approval-gated `ns_search_save`, `customscript_ns_agent_search_rl` deployed; live tool evals data-explorer 8/8, search-builder 6/6. Live approved save done 2026-10-21 (approved by the user as `doma`, approval c26582ed…): `customsearch_nsagent_ar_over_60` "NS Agent - Open invoices over 60 days", internal id 2822, private; the role needed no extra permission; replaying the approvalId was refused (audit: requested, decided, tool.call, rejected). Still open: agent cases need an agent-host adapter; enabling search-builder is the user's call. CP1 PASSED: signed off by the user on 2026-10-21 (evidence: release-reports/2026-10-21T00-35-07-849Z/summary.json, commit 658a44d).
- Phase 2 (2026-10-21, cont.): search-builder 1.0.0 **enabled** (PR #14); `.env` has `NS_AGENT_APPROVERS=doma` so saves work through approval. Step 11 done (PR #15): `packages/report-engine` + reports skill 0.1.0 **disabled** (`ns_report_list`, `ns_report_run`, `ns_report_export_query`; definitions ar-aging, open-sales-orders, vendor-bills-due in `skills/reports/definitions/`); files go to `exports/` (git-ignored); live tool evals 8/8. Enabling reports is the user's call. Sales order status codes in SuiteQL are single letters (A pending approval, B pending fulfilment, D partially fulfilled, E pending billing/partially fulfilled, F pending billing, G billed, H closed).
- Phase 2 steps 9-12 done (2026-10-21): reports 1.0.0 **enabled** (PR #17; gateway serves 10 tools). Step 12 (PR #18): `packages/import-engine` + data-importer 0.1.0 **disabled**, `ns_import_plan` + `ns_import_dry_run` only (no NetSuite writes; load tool waits for CP3). CSVs are read only from `imports/` (`NS_AGENT_IMPORT_DIR`, git-ignored); evals use `skills/data-importer/evals/fixtures`. Live tool evals: data-explorer 8/8, search-builder 6/6, reports 8/8, data-importer 5/5. Terms (and customer category) lists are not queryable by the role, so those references are reported as unverified.
- CP3 (2026-10-21): ADR 0005; `ns_import_run` (data-importer 2.0.0, enabled) creates customers from a dry-run-clean CSV only through approval, bound to the file's sha256 (PR #22). Role `customrole_ns_agent` now has Lists > Customers = **Create** (deployed by SDF; re-import matches). First live load approved by the user (approval ff6b6b4f…): 2 synthetic customers `nsagent-cp3-test-001/002` (internal ids 2828, 2829, US West, USD); replay refused; audit requested/decided/tool.call(2 rows)/rejected. They were deleted again on 2026-10-21 through the approved delete path (below). Agent-eval adapter merged (PR #21, `pnpm skills:eval --mode agent|triggers`, about $2-3 per agent run): triggers 4/4, agent cases 5/13; readings and proposed case fixes in docs/agent-evals.md, awaiting the owner's decision before any eval case changes.
- Deletes (2026-10-21, ADR 0006, PR #25): `ns_record_delete_preview` (read-only, returns a snapshot of last-modified times) + approval-gated `ns_record_delete` (bound to the snapshot, re-checked before deleting; customers only; internal ids; max 25). data-importer 3.0.0. Role `customrole_ns_agent`: Lists > Customers = **Full** (NetSuite grants delete only at Full; no edit tool exists). First approved delete (approval 52fd1781…, approved by the user): customers 2828 and 2829 deleted; SuiteQL confirms they are gone; replay refused. Agent evals (PR #24, docs/agent-evals.md): 12/13 on the second run, the remaining data-importer case fixed and passing; a full agent run costs about $10.
- 2026-10-20 doctor on the Mac: 0 failed, 1 warning. Node 26.7.0, pnpm 10.28.0 (installed via npm; Node 26 ships no corepack), git, OpenSSL 3.6.5, Temurin JDK 21.0.12, SuiteCloud CLI 4.1.1, Claude Code PASS; node_modules installed; `pnpm check` passes on Node 26. Warning: SuiteCloud CLI is supported on Node 24 LTS; if `suitecloud` misbehaves on 26, run it under Node 24. The doctor's earlier 'no JDK' result was a bug (it ignored stderr), fixed in scripts/doctor.mjs.
- CP0 progress (2026-10-20): role `customrole_ns_agent` (internal id 1454, NS Agent Integration) created: Web Services Only, all subsidiaries; Setup: Log in using OAuth 2.0 Access Tokens = Full, REST Web Services = Full; Reports: SuiteAnalytics Workbook = Edit (View is not offered); Lists (View): Clients, Vendors, Items, Employees, Contacts, Subsidiaries, Currency, Accounts, Departments; Transactions (View): Find Transaction, Invoice, Master Contract (= Sales Order, renamed), Client Payment, Credit Memo, Estimate, Opportunity, Purchase Order, Vendor Invoices, Pay Vendor Invoices, Make Journal Entry. Role added to employee 2815 'Integration User' (the user's own login, Dominick.Amirr@...). Account concurrency limit 5, none allocated, recent peak 3: allocate 2 to NS Agent Gateway once the integration record exists. Record renames in this account: Customers = Clients, Sales Order = Master Contract, Bills = Vendor Invoices, Customer Payment = Client Payment.
- CP0 result (2026-10-20): `pnpm ns:ping` passes token, SuiteQL (1014 customers) and metadata catalog (135 record types). Explore RESTlet returns 401 INVALID_LOGIN_ATTEMPT because it is not deployed yet (CP1 step 5). Integration record 'NS Agent Gateway' (internal id 207): Client Credentials grant only, scopes REST Web Services + RESTlets, concurrency limit 2 (account limit 5). Active M2M mapping uses certificate ID jxqM14Kc… (the one in .env). The older mapping C96V3… (superseded certificate) was revoked on 2026-10-21; jxqM14Kc… is the only active mapping. Lesson: re-running the openssl certificate command overwrites private.pem and breaks the mapping; never re-run it. Debug token failures with SuiteQL: SELECT date, status, detail FROM loginaudit WHERE oauthappname = 'NS Agent Gateway' (filters on user or LIKE are rejected).
- Certificate: macOS ships LibreSSL as `openssl`. If the RSA-PSS command fails, either use OpenSSL 3 or make an EC certificate and set `NS_JWT_ALG=ES256`.

## Rules that are not negotiable

- **Never write to NetSuite outside the approval path.** No `ns_createRecord`, no record PUT/POST/PATCH/DELETE, no CSV imports, no live config edits. Account changes ship only as SDF objects in `netsuite/` via PR and `deploy-sdf.yml` (ADR 0002).
- **Live tests only against `NS_TARGET_KIND=sandbox|demo`.** The scripts enforce this; do not bypass `scripts/lib/target.ts`.
- **No secrets in the repo or in output.** IDs go in `.env` (gitignored). The private key stays outside the repo (`NS_PRIVATE_KEY_PATH`); never print, copy, cat or commit it. Do not log NetSuite response bodies.
- **All NetSuite traffic goes through `packages/ns-client`** (auth, limiter, retries). No direct `fetch` to NetSuite anywhere else.
- **Skills follow `docs/skill-lifecycle.md`:** evals first, ship `enabled: false`, version bump + CHANGELOG entry on every change, `pnpm skills:validate` clean.
- Commits: small, imperative subject, one concern each. Open PRs for anything under `netsuite/src/Objects/` or `apps/mcp-gateway/src/policy/`.

## Commands

| Command | Use |
| --- | --- |
| `node scripts/doctor.mjs` | Verifies tools (Node, pnpm, git, OpenSSL, JDK, SuiteCloud CLI, Claude Code), repo and `.env`; no dependencies needed |
| `pnpm check` | Offline gate: typecheck, unit tests, contract replay, skills validation. Run before every commit. |
| `pnpm ns:ping` | Read-only M2M check against the live account |
| `pnpm contracts:record` | Record sanitized live responses to `tests/contract/fixtures` (review the diff) |
| `pnpm skills:eval --mode tools [--skill x]` | Run tool eval cases against the live account |
| `pnpm load:test` | Concurrency/throttling test through one limiter |
| `pnpm release:check` | All gates in order; writes `release-reports/<ts>/summary.json` |
| `pnpm new:skill <name> [--writes]` | Scaffold a disabled skill |
| `pnpm gateway` | Run the MCP server on stdio |

Environment: `set -a; source .env; set +a` before live commands.

## Layout

`packages/ns-client` (only NetSuite I/O) · `packages/suiteql` (query guards) · `packages/report-engine` (report definitions, CSV/XLSX) · `packages/import-engine` (CSV mapping, dry run) · `packages/schemas` (skill manifest + eval schemas) · `apps/mcp-gateway` (tools, policy, skill loading, validator) · `netsuite/` (SDF ACP) · `skills/` · `scripts/` · `tests/contract` · `docs/` (ADRs, release, lifecycle, Phase 0 findings, role spec).

## Account facts (demo account TSTDRV1755417)

- Environment type PRODUCTION, but a demo/test-drive account: use `NS_TARGET_KIND=demo`.
- OneWorld, 27 subsidiaries (elimination and DNU ones included), multi-currency. Never sum `foreign*` amounts across currencies.
- Already enabled: OAuth 2.0, REST Web Services, Server SuiteScript, SDF.
- SuiteQL quirk: `COUNT(*)` + table alias + `ORDER BY` fails; use `COUNT(t.id)`.
- 232 existing `custbody` fields; everything we create uses the `nsagent` prefixes in `skills/ns-conventions`.

## Next work, in order

### CP0 (needs the account admin)
1. Integration role `customrole_ns_agent` per `docs/netsuite-role.md`. DECIDED 2026-10-21: no dedicated "NS Agent" employee (it would use a user licence, need a password and a second key pair). The M2M mapping stays on the user's own employee 2815 "Integration User" with the NS Agent Integration role. Do not revoke the jxqM14Kc… mapping and do not ask for a dedicated employee again unless the user raises it.
2. Integration record (Client Credentials grant; scopes REST Web Services + RESTlets); certificate mapped; Certificate ID noted.
3. Concurrency slice for the integration; set `NS_MAX_CONCURRENCY`.
4. `pnpm ns:ping` passes (RESTlet check may fail until step 5).

### CP1 (read-only release)
5. `suitecloud object:import` the role into `netsuite/src/Objects/`, commit; then `suitecloud project:deploy` the explore RESTlet.
6. `pnpm contracts:record`; review and commit fixtures.
7. `pnpm release:check` on a clean commit; fix failures; attach `summary.json` to the CP1 row.
8. Connect the gateway to an agent and try the data-explorer agent cases in `skills/data-explorer/evals/tasks.yaml` by hand; note results.

### Phase 2 (after CP1 passes)
9. ~~Real approval service replacing `DenyAllApprovals`~~ (done, PR #9) (bind approval to payload hash; named approver; audit `approvalId`).
10. ~~`search-builder` skill~~ (done, PRs #10, #11, #14; enabled): `pnpm new:skill search-builder --writes`; evals first; `search_rl.js` RESTlet; `ns_search_preview`, then `ns_search_save` behind approval.
11. ~~`reports` skill + `packages/report-engine`~~ (done, PR #15) (SuiteQL definitions, CSV/XLSX export).
12. ~~`data-importer` skill~~ (done, PR #18; disabled): plan + dry-run tools only (no `ns_import_run` until CP3).
