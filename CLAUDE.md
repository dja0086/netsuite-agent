# netsuite-agent: notes for Claude Code

MCP gateway + SuiteCloud project + agent skills that let an AI agent search, report on and (later, with approval) change NetSuite data. Design and delivery plan live in the "NetSuite Agent Monorepo" doc (Architecture & design, Delivery plan tabs). Current phase: **CP1, read-only data explorer**.

## Start of every session

1. Run `node scripts/doctor.mjs` and read every FAIL and WARN. Verify, never assume: if a tool is missing, stop and tell the user what to install (doctor prints the fix); do not install system software (JDK, Homebrew packages, global npm CLIs) without asking.
2. `git status` and `git log --oneline -5` to see where work stopped.
3. Read "Handoff state" below, then continue at the first unchecked item in "Next work".
4. Before live commands: `set -a; source .env; set +a`.

## Handoff state (2026-10-20)

- Repo: Phase 1, release tooling and doctor are committed; `pnpm check` passes (87 tests); delivered to `~/dev/netsuite-agent` without `node_modules` (run `pnpm install` first).
- NetSuite account TSTDRV1755417 (demo): OAuth 2.0, REST Web Services, Server SuiteScript and SDF already enabled. CP0 auth done (see below).
- CP1 (2026-10-20, branch `cp1-read-only`, no git remote yet so no PR): SDF auth ID `nsagent-demo` (Administrator @ TSTDRV1755417). The first `account:setup` linked production account 9173162 by mistake and was removed: always run `suitecloud account:manageauth --info nsagent-demo` and confirm the Account ID before any SDF deploy. Role imported, explore RESTlet deployed, `ns:ping` passes all 4 steps. Web Services Only was turned off on the role (it blocks OAuth 2.0 RESTlet logins with InsufficientPermissions); since the role can now log in to the UI, it should move to a dedicated "NS Agent" employee instead of 2815. Open: NetSuite added Other Addresses = Full to the role on deploy (docs/netsuite-role.md). Fixtures recorded (`658a44d`). `pnpm release:check` PASSED on clean commit 658a44d: release-reports/2026-10-21T00-35-07-849Z/summary.json (evals 7/7, load test 40/40 at concurrency 2, no throttling). Contract findings: SuiteQL returns values as strings; record GET with `fields` omits `id`.
- 2026-10-20 doctor on the Mac: 0 failed, 1 warning. Node 26.7.0, pnpm 10.28.0 (installed via npm; Node 26 ships no corepack), git, OpenSSL 3.6.5, Temurin JDK 21.0.12, SuiteCloud CLI 4.1.1, Claude Code PASS; node_modules installed; `pnpm check` passes on Node 26. Warning: SuiteCloud CLI is supported on Node 24 LTS; if `suitecloud` misbehaves on 26, run it under Node 24. The doctor's earlier 'no JDK' result was a bug (it ignored stderr), fixed in scripts/doctor.mjs.
- CP0 progress (2026-10-20): role `customrole_ns_agent` (internal id 1454, NS Agent Integration) created: Web Services Only, all subsidiaries; Setup: Log in using OAuth 2.0 Access Tokens = Full, REST Web Services = Full; Reports: SuiteAnalytics Workbook = Edit (View is not offered); Lists (View): Clients, Vendors, Items, Employees, Contacts, Subsidiaries, Currency, Accounts, Departments; Transactions (View): Find Transaction, Invoice, Master Contract (= Sales Order, renamed), Client Payment, Credit Memo, Estimate, Opportunity, Purchase Order, Vendor Invoices, Pay Vendor Invoices, Make Journal Entry. Role added to employee 2815 'Integration User' (the user's own login, Dominick.Amirr@...). Account concurrency limit 5, none allocated, recent peak 3: allocate 2 to NS Agent Gateway once the integration record exists. Record renames in this account: Customers = Clients, Sales Order = Master Contract, Bills = Vendor Invoices, Customer Payment = Client Payment.
- CP0 result (2026-10-20): `pnpm ns:ping` passes token, SuiteQL (1014 customers) and metadata catalog (135 record types). Explore RESTlet returns 401 INVALID_LOGIN_ATTEMPT because it is not deployed yet (CP1 step 5). Integration record 'NS Agent Gateway' (internal id 207): Client Credentials grant only, scopes REST Web Services + RESTlets, concurrency limit 2 (account limit 5). Active M2M mapping uses certificate ID jxqM14Kc… (the one in .env). An older mapping C96V3… holds a superseded certificate and fails with SignatureValidation; revoke it once the user agrees. Lesson: re-running the openssl certificate command overwrites private.pem and breaks the mapping; never re-run it. Debug token failures with SuiteQL: SELECT date, status, detail FROM loginaudit WHERE oauthappname = 'NS Agent Gateway' (filters on user or LIKE are rejected).
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

`packages/ns-client` (only NetSuite I/O) · `packages/suiteql` (query guards) · `packages/schemas` (skill manifest + eval schemas) · `apps/mcp-gateway` (tools, policy, skill loading, validator) · `netsuite/` (SDF ACP) · `skills/` · `scripts/` · `tests/contract` · `docs/` (ADRs, release, lifecycle, Phase 0 findings, role spec).

## Account facts (demo account TSTDRV1755417)

- Environment type PRODUCTION, but a demo/test-drive account: use `NS_TARGET_KIND=demo`.
- OneWorld, 27 subsidiaries (elimination and DNU ones included), multi-currency. Never sum `foreign*` amounts across currencies.
- Already enabled: OAuth 2.0, REST Web Services, Server SuiteScript, SDF.
- SuiteQL quirk: `COUNT(*)` + table alias + `ORDER BY` fails; use `COUNT(t.id)`.
- 232 existing `custbody` fields; everything we create uses the `nsagent` prefixes in `skills/ns-conventions`.

## Next work, in order

### CP0 (needs the account admin)
1. Integration role `customrole_ns_agent` per `docs/netsuite-role.md`; employee "NS Agent" with that role.
2. Integration record (Client Credentials grant; scopes REST Web Services + RESTlets); certificate mapped; Certificate ID noted.
3. Concurrency slice for the integration; set `NS_MAX_CONCURRENCY`.
4. `pnpm ns:ping` passes (RESTlet check may fail until step 5).

### CP1 (read-only release)
5. `suitecloud object:import` the role into `netsuite/src/Objects/`, commit; then `suitecloud project:deploy` the explore RESTlet.
6. `pnpm contracts:record`; review and commit fixtures.
7. `pnpm release:check` on a clean commit; fix failures; attach `summary.json` to the CP1 row.
8. Connect the gateway to an agent and try the data-explorer agent cases in `skills/data-explorer/evals/tasks.yaml` by hand; note results.

### Phase 2 (after CP1 passes)
9. Real approval service replacing `DenyAllApprovals` (bind approval to payload hash; named approver; audit `approvalId`).
10. `search-builder` skill: `pnpm new:skill search-builder --writes`; evals first; `search_rl.js` RESTlet; `ns_search_preview`, then `ns_search_save` behind approval.
11. `reports` skill + `packages/report-engine` (SuiteQL definitions, CSV/XLSX export).
12. `data-importer` skill: plan + dry-run tools only (no `ns_import_run` until CP3).
