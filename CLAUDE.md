# netsuite-agent: notes for Claude Code

MCP gateway + SuiteCloud project + agent skills that let an AI agent search, report on and, through approvals, change NetSuite data. Design and delivery plan live in the "NetSuite Agent Monorepo" doc (Architecture & design, Delivery plan tabs); a snapshot of the design tab is in `docs/design.md` (ADRs and this file win where they differ). Current phase: **CP1, CP2 and CP3 passed** (CP3 owner sign-off 2026-10-28, evidence in `docs/cp3-evidence.md`). Next: Phase 4 (CP4), only when the owner starts it.

## Start of every session

1. Run `node scripts/doctor.mjs` and read every FAIL and WARN. Verify, never assume: if a tool is missing, stop and tell the user what to install (doctor prints the fix); do not install system software (JDK, Homebrew packages, global npm CLIs) without asking.
2. `git status` and `git log --oneline -5` to see where work stopped.
3. Read "Current state" below, then continue at the first unchecked item in "Next work".
4. Before live commands: `set -a; source .env; set +a`.

## Current state (2026-10-28)

### GitHub

- **Account rule (2026-10-22, full rule in ~/.claude/CLAUDE.md):** all pushes, new repos and PRs go to github.com/dja0086, never dja-cowboyallstar. Before pushing: if `git remote get-url origin` is not https://github.com/dja0086/netsuite-agent.git, repoint it with `git remote set-url origin https://github.com/dja0086/netsuite-agent.git` (create the repo under dja0086 first if it does not exist, private), and run `gh auth switch --user dja0086` if that account is not active. Approval-channel settings (`NS_AGENT_GITHUB_REPO`, `NS_AGENT_APPROVERS`) must name dja0086 too.
- **The repo is public (owner decision 2026-10-23)**, so GitHub environment protections work on the free plan. Gitleaks found no secrets in the full history before it was opened; the owner accepted publishing account IDs and commit emails. **Before making it private again, upgrade to a plan with environment protection for private repos (Team or Enterprise), or delete the deploy secrets first.** The deploy secret goes only in the `production` environment, never at repository level (`docs/release.md`, "Approval").
- History: PRs #1-#30 were merged on the old dja-cowboyallstar repo, where GitHub Actions never ran. On dja0086 Actions works (owner confirmed 2026-10-22): CI (`ci.yml`: typecheck, tests, skills validation, gitleaks) gates merges. Run `pnpm check` locally before pushing; local gitleaks (`docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:latest detect --source /repo --redact --no-banner`, needs `colima start`) is optional.

### NetSuite access

- Account TSTDRV1755417 (demo, `NS_TARGET_KIND=demo`): OAuth 2.0, REST Web Services, Server SuiteScript and SDF enabled.
- Integration record "NS Agent Gateway" (internal id 207): Client Credentials grant only; scopes REST Web Services + RESTlets; concurrency limit 2 of the account's 5 (`NS_MAX_CONCURRENCY=2`).
- **Integration user: employee 2815 "Integration User"** (the user's own login, Dominick.Amirr@…) with role NS Agent Integration. DECIDED 2026-10-21 by the user: no dedicated "NS Agent" employee (it would use a user licence, need a password and a second key pair). Do not ask for one again unless the user raises it.
- **Active M2M mapping: certificate ID jxqM14Kc…** (the one in `.env`); do not revoke it. The older mapping C96V3… was revoked on 2026-10-21. Never re-run the openssl certificate command: it overwrites `private.pem` and breaks the mapping (that is what broke C96V3…).
- Debug token failures with SuiteQL: `SELECT date, status, detail FROM loginaudit WHERE oauthappname = 'NS Agent Gateway'` (filters on user or LIKE are rejected).
- Role `customrole_ns_agent` (internal id 1454, "NS Agent Integration"), all subsidiaries; permission table in `docs/netsuite-role.md`:
  - Web Services Only is **off**: with it on, OAuth 2.0 RESTlet logins fail with InsufficientPermissions. The role can therefore log in to the UI.
  - Lists > Customers = **Full** (ADR 0005 creates, ADR 0006 deletes; NetSuite grants delete only at Full; no edit tool exists). View on the other lists and transaction types; SuiteAnalytics Workbook = Edit (View is not offered).
  - NetSuite forces Other Addresses = Full on every role save; it stays in the XML so the repo matches the account.
- SDF: auth ID `nsagent-demo` (Administrator @ TSTDRV1755417). The first `account:setup` once linked production account 9173162 by mistake and was removed: **always run `suitecloud account:manageauth --info nsagent-demo` and confirm the Account ID before any SDF deploy.** Deployed: the role (now with Custom Record Entries = View, for PDF previews), the explore RESTlet, the search RESTlet (`customscript_ns_agent_search_rl`) and the PDF preview RESTlet (`customscript_ns_agent_pdf_rl`, renders then checks resources with `lib/resource_scan.js`, deployed 2026-10-23 from 95ce0aa = main). Deploys go through `deploy-sdf.yml` (one job, environment `production` = demo, approval by dja0086 in GitHub's Review deployments; secret `NS_PROD_SDF_PRIVATE_KEY`, vars `NS_PROD_ACCOUNT_ID` and `NS_PROD_SDF_CERT_ID`; CI key in `~/.netsuite-agent/sdf-ci/`, mapping to Administrator + SuiteCloud Development Integration, cert expires 2027-10-23). Local `nsagent-demo` deploys remain the fallback. Protections (2026-10-23): `main` requires a PR and the checks `checks`, `secret-scan`, `sdf-check` (no force push or deletion; admins not enforced); environment `production` requires reviewer dja0086 and allows only protected branches.

### Skills, tools and approvals

- The gateway serves 15 tools. Disabled skills (not served): custom-fields 0.1.0 (`ns_field_plan`, `ns_field_generate`; script ID probed account-wide with SuiteQL, fails safe). Open, not merged: #10 (`ns_pdf_preview` and the pdf-templates skill, passed the SuiteCloud acceptance loop) and #11 (`ns_pdf_template_generate`, `ns_change_open_pr`; failed the loop: `ns_change_open_pr` pushes without approval). Neither is needed for CP3. Enabled skills: data-explorer 1.1.1 (read-only), reports 1.0.0 (read-only; definitions ar-aging, open-sales-orders, vendor-bills-due in `skills/reports/definitions/`; files go to `exports/`, git-ignored), search-builder 1.0.0 (`ns_search_preview`; `ns_search_save` approval-gated), data-importer 3.0.0 (`ns_import_plan`, `ns_import_dry_run`; `ns_import_run` creates customers from a dry-run-clean CSV, bound to the file's sha256, ADR 0005; `ns_record_delete_preview` + `ns_record_delete`, customers only, internal ids, max 25, bound to a last-modified snapshot, ADR 0006). CSVs are read only from `imports/` (`NS_AGENT_IMPORT_DIR`, git-ignored); evals use `skills/data-importer/evals/fixtures`. Platform skills: change-control 0.1.4 (PR review is the control for PDF templates; sdf-gen's `templateSourceIssues` is a lint), ns-conventions 1.0.4 (field names at most 21 characters after the prefix).
- Approvals (ADR 0004): `StoredApprovals` is used when `NS_AGENT_APPROVERS` is set (demo/sandbox only); approvals live in `audit/approvals.sqlite`; decide with `pnpm approvals list|show|approve|deny`. `.env` has `NS_AGENT_APPROVERS=doma` (local channel). The GitHub issue channel (`NS_AGENT_APPROVAL_CHANNEL=github`, `NS_AGENT_GITHUB_REPO`, approvers = GitHub logins) is the only channel allowed in production; it was tested live on the old repo (issue #29) and decisions are audited as `approval.decided`. It is not switched on in `.env` yet; when it is, use `dja0086/netsuite-agent` and approver `dja0086`.
- Live writes so far, each approved by the user and each replay refused:
  - Saved search `customsearch_nsagent_ar_over_60` "NS Agent - Open invoices over 60 days" (internal id 2822, private; approval c26582ed…).
  - Saved search `customsearch_nsagent_github_approval_test` (internal id 2922, kept; approved on GitHub issue #29).
  - Customers `nsagent-cp3-test-001/002` (internal ids 2828, 2829; approval ff6b6b4f…), deleted again through the approved delete path (approval 52fd1781…); SuiteQL confirms they are gone.
- Account changes deployed through `deploy-sdf` (each owner-approved, 0 errors; details in `docs/cp3-evidence.md`): field `custbody_nsagent_rush` "Rush order" (#9; relabelled in #14 and reverted in #15 for the rollback rehearsal), template `custtmpl_nsagent_invoice_standard` "NS Agent - Invoice" (#16, not preferred). Both stay in the account; removing them is a manual UI step.
- Evals: `pnpm skills:eval --mode tools|agent|triggers` (agent and trigger modes need the `claude` CLI logged in; a full agent run costs about $10). Agent cases 12/13 on the last full run, the remaining data-importer case fixed and passing (`docs/agent-evals.md`). CP1 hand trials: `docs/cp1-agent-trials.md`.

### Checkpoints and release evidence

- CP0: auth done (`pnpm ns:ping` passes all 4 steps: token, SuiteQL, metadata catalog, explore RESTlet). Its open `[FILL]` policy items are carried to CP5.
- CP1 PASSED (owner sign-off 2026-10-21): `release:check` on clean commit 658a44d, `release-reports/2026-10-21T00-35-07-849Z/summary.json` (evals 7/7, load 40/40 at concurrency 2, no throttling).
- CP2 PASSED (owner sign-off 2026-10-22).
- Latest `release:check`: PASSED on 4810a2d (`release-reports/2026-10-21T13-20-34-917Z/summary.json`: tool evals 30/30, triggers 45/45, load 40/40; p50 latency 17.8 s vs 3.1 s at CP1, NetSuite slower that day, no throttling).
- CP3 PASSED (owner sign-off 2026-10-28): field #9, template #16, rollback #14/#15, importer by ADR 0005; evidence in `docs/cp3-evidence.md`.

### Findings worth remembering

- Contract tests: SuiteQL returns values as strings; record GET with `fields` omits `id`.
- Sales order status codes in SuiteQL are single letters (A pending approval, B pending fulfilment, D partially fulfilled, E pending billing/partially fulfilled, F pending billing, G billed, H closed).
- Terms and customer category lists are not queryable by the role, so those references are reported as unverified.
- Mac toolchain (doctor, 2026-10-20): Node 26.7.0, pnpm 10.28.0 (installed via npm; Node 26 ships no corepack), git, OpenSSL 3.6.5, Temurin JDK 21.0.12, SuiteCloud CLI 4.1.1, Claude Code. SuiteCloud CLI is supported on Node 24 LTS; if `suitecloud` misbehaves on 26, run it under Node 24.
- Certificate: macOS ships LibreSSL as `openssl`. If the RSA-PSS command fails, either use OpenSSL 3 or make an EC certificate and set `NS_JWT_ALG=ES256`.

## Rules that are not negotiable

- **Never write to NetSuite outside the approval path.** Data writes happen only through the approval-gated tools (`ns_search_save`, `ns_import_run`, `ns_record_delete`; ADRs 0004-0006). No other record PUT/POST/PATCH/DELETE, no CSV import jobs, no `ns_createRecord`, no live configuration edits. Account changes ship only as SDF objects in `netsuite/` via PR (ADR 0002).
- **Live tests only against `NS_TARGET_KIND=sandbox|demo`.** The scripts enforce this; do not bypass `scripts/lib/target.ts`.
- **No secrets in the repo or in output.** IDs go in `.env` (gitignored). The private key stays outside the repo (`NS_PRIVATE_KEY_PATH`); never print, copy, cat or commit it. Do not log NetSuite response bodies.
- **All NetSuite traffic goes through `packages/ns-client`** (auth, limiter, retries). No direct `fetch` to NetSuite anywhere else.
- **Skills follow `docs/skill-lifecycle.md`:** evals first, ship `enabled: false`, version bump + CHANGELOG entry on every change, `pnpm skills:validate` clean.
- Commits: small, imperative subject, one concern each. Open PRs for anything under `netsuite/src/Objects/` or `apps/mcp-gateway/src/policy/`.

## Commands

| Command | Use |
| --- | --- |
| `node scripts/doctor.mjs` (`pnpm doctor`) | Verifies tools (Node, pnpm, git, OpenSSL, JDK, SuiteCloud CLI, Claude Code), repo and `.env`; no dependencies needed |
| `pnpm check` | Offline gate: typecheck, unit tests, contract replay, skills validation. Run before every commit. |
| `pnpm ns:ping` | Read-only M2M check against the live account |
| `pnpm contracts:record` | Record sanitized live responses to `tests/contract/fixtures` (review the diff) |
| `pnpm skills:eval --mode tools\|agent\|triggers [--skill x]` | Tool cases against the live account; agent and trigger cases through the `claude` CLI |
| `pnpm load:test` | Concurrency/throttling test through one limiter |
| `pnpm release:check` | All gates in order; writes `release-reports/<ts>/summary.json` |
| `pnpm approvals list\|show\|approve\|deny` | Inspect and decide pending approvals (local channel) |
| `pnpm new:skill <name> [--writes]` | Scaffold a disabled skill |
| `pnpm gateway` | Run the MCP server on stdio (`.mcp.json` starts it for Claude Code via `scripts/mcp-gateway.sh`) |

Environment: `set -a; source .env; set +a` before live commands.

## Layout

`packages/ns-client` (only NetSuite I/O) · `packages/suiteql` (query guards) · `packages/report-engine` (report definitions, CSV/XLSX) · `packages/import-engine` (CSV mapping, dry run) · `packages/sdf-gen` (field and PDF template specs → SDF XML) · `packages/schemas` (skill manifest + eval schemas) · `apps/mcp-gateway` (tools, policy, skill loading, validator) · `netsuite/` (SDF ACP) · `skills/` · `scripts/` · `tests/contract` · `docs/` (ADRs, release, lifecycle, agent evals, Phase 0 findings, role spec).

## Account facts (demo account TSTDRV1755417)

- Environment type PRODUCTION, but a demo/test-drive account: use `NS_TARGET_KIND=demo`.
- OneWorld, 27 subsidiaries (elimination and DNU ones included), multi-currency. Never sum `foreign*` amounts across currencies.
- Already enabled: OAuth 2.0, REST Web Services, Server SuiteScript, SDF.
- SuiteQL quirk: `COUNT(*)` + table alias + `ORDER BY` fails; use `COUNT(t.id)`.
- 232 existing `custbody` fields; everything we create uses the `nsagent` prefixes in `skills/ns-conventions`.
- Record renames in this account: Customers = Clients, Sales Order = Master Contract, Bills = Vendor Invoices, Customer Payment = Client Payment.

## Next work, in order

### Done (details in the Delivery plan and git history)

- [x] CP0: integration role, integration record, certificate mapping, concurrency slice, `ns:ping`.
- [x] CP1: role imported, explore RESTlet deployed, contract fixtures, `release:check`, hand-tried agent cases.
- [x] Phase 2 / CP2: approval service (ADR 0004, incl. GitHub channel), search-builder, reports + `report-engine`, data-importer + `import-engine`.
- [x] Beyond the plan (owner's request): approved customer imports (ADR 0005, REST Record API), approved deletes (ADR 0006), agent-eval adapter.

### Housekeeping (before Phase 3)

- [x] Follow the GitHub account rule: repoint `origin`, push, and open PRs on dja0086 only.
- [x] Replace the dja-cowboyallstar owner handle with dja0086 in `.github/CODEOWNERS`, every `skills/*/OWNERS`, the skill manifests' `owner`, the `.env.example` example and `apps/mcp-gateway/test/github-channel.test.ts`; patch-bump each changed skill with a CHANGELOG entry; `pnpm check` clean. Leave old CHANGELOG lines as history.
- [ ] Switch approvals to the GitHub channel in `.env` (`NS_AGENT_APPROVAL_CHANNEL=github`, `NS_AGENT_GITHUB_REPO=dja0086/netsuite-agent`, `NS_AGENT_APPROVERS=dja0086`); tell the user what token access is needed instead of creating one.

### Phase 3 → CP3 (tasks as in the Delivery plan)

- [x] Build `sdf-gen` for the needed field types and `advancedpdftemplate` (#3, #6)
- [ ] Deploy `pdf_rl.js` (done: #2, #7, deployed 2026-10-23); wire `ns_pdf_preview` (#10, passed review, not merged; not needed for CP3)
- [x] Wire `deploy-sdf.yml` with an approval step (#4, #8, #13) (DECIDED 2026-10-25 by the owner: one account, one environment `production` = demo, one approval; no sandbox stage)
- [x] Push one field and one template through to production (#9, #16)
- [x] Rehearse rollback with a revert PR (#14, #15)
- [x] **Owner sign-off on CP3** (2026-10-28; evidence: `docs/cp3-evidence.md`)
- [x] ~~Deploy `import_rl.js` and the first saved import map~~ Superseded by ADR 0005: imports use the REST Record API, not a CSV import RESTlet.
- [x] ~~Run a sandbox import, reconcile it, then enable `ns_import_run` (minor release)~~ `ns_import_run` enabled under ADR 0005 (data-importer 2.0.0). DECIDED 2026-10-22 by the owner: ADR 0005's acceptance counts for CP3's importer criterion; no row-for-row reconciliation file is needed.

Read `docs/design.md` ("2. Creating custom fields", "3. Customizing PDFs", "Phase 3") before planning. Skills from the design for this phase: custom-fields (`ns_field_plan`, `ns_field_generate`) and pdf-templates (`ns_pdf_preview`, `ns_pdf_template_generate`); change-control gains `ns_change_open_pr`. New skills follow the lifecycle: evals first, shipped disabled.

### Phase 4 → CP4

- [ ] Write the custom tool script (`N/query` only) and JSON schema for the top read tools
- [ ] Create the tool SDF object; deploy as an account customization project
- [ ] Connect an MCP client to the AI Connector endpoint; confirm tool visibility under the integration role
- [ ] Run the parity test against the gateway

### Phase 5 → CP5

- [ ] Configure PII redaction rules and audit log retention
- [ ] Alert on rejected-request ratio and failed approvals
- [ ] Review the integration role's permissions
- [ ] Write the runbook; name the on-call owner
- [ ] Production rollout through change-control; go-live sign-off

### Exit gates (from the Delivery plan)

| Checkpoint | Exit criteria | Evidence | Sign-off |
| --- | --- | --- | --- |
| CP3 Change control proven | One custom field and one PDF template go PR to sandbox to production with approvals; rollback rehearsed by revert; importer writes enabled after a sandbox import reconciles row for row | Deploy logs; revert PR; reconciliation file | NetSuite admin, finance contact |
| CP4 Connector live | Custom tools deployed as an account customization project; visible in an MCP client under the integration role; `N/query` only; results match the gateway | Client tool listing; parity test results | NetSuite admin |
| CP5 Go-live | PII redaction rules, audit retention, rejected-request alerting, permission review, runbook and on-call owner in place | Runbook link; alert test; sign-off record | Sponsor [FILL], security, NetSuite admin |

CP3 note (owner decision 2026-10-25): there is no sandbox, so "PR to sandbox to production with approvals" means PR → the one account (environment `production` = demo TSTDRV1755417) with one approval in `deploy-sdf`.

CP3 note (owner decision 2026-10-22): the importer part of CP3 ("importer writes enabled after a sandbox import reconciles row for row", evidence "reconciliation file") is met by ADR 0005's acceptance. What remains for CP3 is the custom field, the PDF template, the approved PR-to-production path and the revert rehearsal.

Never mark a checkpoint passed yourself: the owner signs off in the Delivery plan.

### Candidates, not scheduled (owner's call)

- Fill the policy `[FILL]`s: audit-log retention, eval thresholds, a production secrets backend, redaction fields (CP5 covers most of these).
- More record types (vendors, contacts) through role-permission PRs, or an update import, which needs its own ADR because it would be the first edit tool.
