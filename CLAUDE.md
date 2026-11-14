# netsuite-agent: notes for Claude Code

An agent builder (`apps/agent-builder`, `pnpm builder`) that turns a NetSuite use case written in plain language into a Claude Managed Agent on Oracle's NetSuite AI Connector, with fixed safety rules; plus the SuiteCloud (SDF) project for account changes. Plan and results: `docs/agent-builder-plan.md` (Phases 1 to 3 done); using it: `docs/agent-builder.md`; operating it: `docs/runbook.md`. The MCP gateway that came first (checkpoints CP0 to CP5, all passed) was **retired 2026-10-31** (ADR 0007); its code is in git history under the tag `gateway-final`, and its docs (`docs/design.md`, `docs/cp*-evidence.md`, ADRs 0001 and 0003-0006) are history.

## The platform plan governs this repo

On 2026-11-14 the owner accepted the Hardened plan for the NetSuite agent platform. It lives in the platform repo, `suitereact-mcp`: [plan](https://github.com/dja0086/suitereact-mcp/blob/main/docs/platform/plan.md) (the specification) and [build brief](https://github.com/dja0086/suitereact-mcp/blob/main/docs/platform/build-brief.md) (the rules a builder follows). [ADR 0008](docs/adr/0008-adopt-the-platform-plan.md) records what it means here.

- **This repo is frozen** (decision D2). Its role tiers move to the platform repo in checkpoint S1; after S1 it takes no new work. Change it only when a plan checkpoint names it, on that checkpoint's branch (`s<N>-<name>`).
- **The old no-write rule is retired** (decision L2). Agents will write to NetSuite through the platform's tool runner from checkpoint S2, and hard-gated actions only from an approved proposal from S3. Until then nothing in this repo gains a new write path, and the builder's existing approval flow stays as it is.
- **D4 reopens the dedicated-user decision.** Each role tier gets a dedicated agent user in S1, instead of the owner's own login.
- When sources disagree, the order is: the owner's instruction, then the plan, then ADRs, then this file. Stop and report the conflict; do not choose. Do not reopen locked decisions L1 to L8; D1 to D7 change only by the owner.
- An exit criterion is met only when shown with a command's output, a CI run or a query result. Separate what you verified from what you inferred.

## Start of every session

1. Run `node scripts/doctor.mjs` and read every FAIL and WARN. Verify, never assume: if a tool is missing, stop and tell the user what to install (doctor prints the fix); do not install system software (JDK, Homebrew packages, global npm CLIs) without asking.
2. `git status` and `git log --oneline -5` to see where work stopped.
3. Confirm the NetSuite account before the first NetSuite call: it must be the pilot account named in untracked config (`.env`, the Managed Agents lock file). Stop on a mismatch. Read account facts (counts, IDs) from a query, never from this file: `npm run session-start` in `suitereact-mcp`, or the connector's read tools.

## Current state (2026-11-14)

### GitHub

- **Account rule (2026-10-22, full rule in ~/.claude/CLAUDE.md):** all pushes, new repos and PRs go to github.com/dja0086, never dja-cowboyallstar. Before pushing: if `git remote get-url origin` is not https://github.com/dja0086/netsuite-agent.git, repoint it, and run `gh auth switch --user dja0086` if that account is not active.
- **The repo is public (owner decision 2026-10-23; kept public by decision D7)**, so GitHub environment protections work on the free plan. **Before making it private again, upgrade to a plan with environment protection for private repos (Team or Enterprise), or delete the deploy secrets first.** The deploy secret goes only in the `production` environment, never at repository level (`docs/release.md`, "Approval"). Issues the builder opens name only the agent and run.
- **No account ID, client name or live resource ID goes in a tracked file** (plan invariant I9). The `identifier-scan` workflow fails new ones; the pilot account ID and the IDs in the lock and tier files are baselined, because runtime code and config still need them. Old commits keep what was removed (D7).
- CI (`ci.yml`): `checks` (typecheck, builder and toolset tests), `sdf-check`, `secret-scan` (gitleaks). `main` requires a PR and those three checks. `identifier-scan.yml` runs the identifier scan. Run `pnpm check` locally before pushing.

### NetSuite access

- One account: the pilot (demo, test-drive) account, `NS_TARGET_KIND=demo`, named in untracked config. A real production account is connected to the same tools: never configure or sign in to it.
- **Agents reach NetSuite only through the AI Connector** `/services/mcp/v1/all` URL of the pilot account (`NETSUITE_MCP_URL` in `src/rules.ts`), signed in as the owner's login with role NS Agent Integration through the integration "SuiteReact MCP (local)" (AI Connector scope only, authorization code grant, confidential client, redirect `http://localhost:57432/callback`, refresh token 168 h). The token lives in the Managed Agents vault named in `managed-agents/phase0/claude-lock.json`; re-sign-in steps in `docs/phase0-managed-agents.md`. suitemcp can no longer sign in through that integration (owner decision).
- **Integration user:** today the owner's own login with role NS Agent Integration. Decision D4 replaces this with one dedicated agent user per tier in S1.
- **Roles are tiers, managed in `roles/tiers.json`** (one role, one sign-in and one vault per tier, shared by agents; never a role per agent) until S1 moves them to the platform repo. Role XML is generated by `pnpm roles` (`node scripts/roles.mjs`); CI checks it matches. Tiers: **Read-only** `customrole_nsagent_read` (no writes; not yet signed in), **Clerk** `customrole_ns_agent` (client create/update; its vault is in `roles/tiers.json`). Signing in a tier: `docs/agent-builder.md`, "Role tiers".
- Role `customrole_ns_agent` (the Clerk tier), permission table in `docs/netsuite-role.md`: Web Services Only off; Lists > Customers = Full (set for the gateway's creates and deletes; the connector only creates and updates); MCP Server Connection = Full; NetSuite forces Other Addresses = Full on every save.
- Toolset `custtoolset_nsagent_read` (`nsagent_suiteql`, `nsagent_record_get`, `N/query` only) **stays**: builder agents use `nsagent_suiteql` as their SuiteQL fallback.
- **Retired with the gateway:** the three RESTlets (explore, search, PDF) are off through SDF, each script inactive and its deployment not deployed (objects kept in `netsuite/` for that reason). The owner revokes the gateway's M2M mapping and inactivates the integration "NS Agent Gateway" themself (owner decision 2026-11-01): not tracked here, do not ask about them. Never re-run the openssl certificate command.
- **How Claude Code reads NetSuite now:** the claude.ai custom connector "NetSuite All" (read tools such as `nsagent_suiteql`, `ns_getSessionInfo`). Its session cannot query `loginaudit`. Never call its write tools (`createCustomer`, `updateCustomer`, `ns_createRecord`, `ns_updateRecord`, …) from Claude Code (build brief rule 9).
- SDF: auth ID `nsagent-demo` (Administrator on the pilot account). **Always run `suitecloud account:manageauth --info nsagent-demo` and confirm the Account ID is the pilot account before any SDF deploy.** Deploys go through `deploy-sdf.yml` (environment `production` = the pilot account, approval by dja0086; CI key in `~/.netsuite-agent/sdf-ci/`, cert expires 2027-10-23). In the account from SDF: the role, the toolset, field `custbody_nsagent_rush`, template `custtmpl_nsagent_invoice_standard` (the last two stay; removing them is a manual UI step).

### Agent builder

- Local web app on http://127.0.0.1:5178 (`pnpm builder`; needs `ant auth login`). Draft from a use case (`claude-opus-5-5`), adjust tools, create; edit saves a new version and repins schedules; run, approve or deny writes on the run page, download files; schedule with cron and time zone. Every run capped at $5.
- Fixed rules (`src/rules.ts`, re-checked by `assertConfigSafe`): reads `always_allow`; requested writes `always_ask`, other writes, file writes and UI tools disabled; toolset default `always_ask`; only the pilot account's `/all` URL; sandbox only when files are produced. Never weaken them without the owner's decision.
- Waiting runs: For you lists them; launchd `com.dja0086.netsuite-agent.builder-pending` (every 15 minutes) opens one GitHub issue per waiting run.
- Agents (2026-10-31): "Weekly 60+ days overdue clients" (scheduled `0 8 * * 1` America/New_York), "Update client email" (test schedule paused), "Top 10 open-balance clients by currency". Local registry `apps/agent-builder/data/` (git-ignored).
- **Flux analysis** (`src/flux/`, `public/flux.js`; `docs/flux-design.md`): reads through the agent "Flux data reader" (`claude-haiku-5-5`, Clerk sign-in until Read-only is signed in, all writes disabled). Rows come from session tool results only for a query matching exactly. Code computes every figure; drafts can't contain figures. Sign-off "who" is typed, not authenticated. Demo data is dense only in 2017. The role cannot read `accountingperiod`, `bom` or bank records.
- Test client `nsagent-phase0-test-001`, email `phase3-test@example.com` (Phase 3 test).
- Approvals in runs are the owner's decisions.
- The desktop app stops preview servers: if the owner's clicks do nothing, check the builder is running (`lsof -nP -iTCP:5178 -sTCP:LISTEN`) and restart it.

### Findings worth remembering

- SuiteQL quirk: `COUNT(*)` + table alias + `ORDER BY` fails; use `COUNT(t.id)`. No `GROUP BY BUILTIN.DF(...)` on `ns_runCustomSuiteQL`; `nsagent_suiteql` allows it. `BUILTIN.DF(NVL(a, b))` errors (use `CASE WHEN a IS NULL ...`). `ROW_NUMBER()` works; `ROWNUM` paging subqueries do not. Consolidate with `BUILTIN.CONSOLIDATE(tal.amount,'LEDGER','DEFAULT','DEFAULT',<target>,t.postingperiod,'DEFAULT')`: the target must be the top-level (headquarters) subsidiary; any other target can silently return local amounts. Look its ID up with a query.
- Sales order status codes in SuiteQL are single letters (A pending approval, B pending fulfilment, D partially fulfilled, E pending billing/partially fulfilled, F pending billing, G billed, H closed).
- Terms and customer category lists are not queryable by the role.
- The pilot account is OneWorld and multi-currency: never sum `foreign*` amounts across currencies. Everything we create uses the `nsagent` prefix. Record renames: Customers = Clients, Sales Order = Master Contract, Bills = Vendor Invoices, Customer Payment = Client Payment.
- Mac toolchain: Node 26.7.0, pnpm 10.28.0, git, Temurin JDK 21, SuiteCloud CLI 4.1.1 (supported on Node 24; if `suitecloud` misbehaves on 26, run it under Node 24), `ant` 2.4.0, `gh`, Claude Code.
- Effective permissions of the owner's login with NS Agent Integration include setup permissions not in the role XML (the employee's global permissions). They stay (owner decision 2026-10-30) until D4's dedicated users replace that login.
- Managed Agents: Anthropic may start a scheduled run up to 9 minutes late. Webhooks need a public HTTPS endpoint, so waiting runs are found by polling.

## Rules that are not negotiable

- **The plan and ADR 0008 govern NetSuite writes** (see the top of this file). Never call Oracle's write tools from Claude Code or through a connector directly, and never perform or route around a hard gate. Never weaken the builder's fixed rules (`src/rules.ts`, `src/catalog.ts`) without the owner's decision.
- **Account changes ship only as SDF objects in `netsuite/` via PR** and an approved `deploy-sdf` run (ADR 0002). No live configuration edits.
- **Pilot account only.** The builder allows only the pilot account's connector URL; never configure the production account.
- **No secrets in the repo or in output.** Never print tokens, the client secret or private keys; `ant auth status` output names the credential, so check its exit code only.
- OAuth consents and integration-record changes are the owner's clicks.
- Commits: small, imperative subject, one concern each. Open PRs for anything under `netsuite/src/Objects/` or `apps/agent-builder/src/rules.ts`.

## Commands

| Command | Use |
| --- | --- |
| `node scripts/doctor.mjs` (`pnpm doctor`) | Verifies tools (Node, pnpm, git, JDK, SuiteCloud CLI, ant and its login, gh as dja0086, Claude Code) and the builder's setup |
| `pnpm check` | Offline gate: typecheck, builder tests, toolset guard tests, SDF check. Run before every commit. |
| `pnpm builder` | Agent builder on http://127.0.0.1:5178 (`docs/agent-builder.md`) |
| `pnpm --filter @ns-agent/agent-builder pending-check` | One run of the waiting-run check (launchd runs it every 15 minutes) |
| `pnpm sdf:check` | Offline SDF checks (XML, object ids, file references, SuiteScript syntax) |
| `pnpm roles` | Regenerates the role files in `netsuite/src/Objects/` from `roles/tiers.json` (`--check` in CI) |
| `node .github/workflows/identifier-scan.mjs --baseline .github/workflows/identifier-baseline.json` | Identifier scan of the current tree, as CI runs it |

## Layout

`apps/agent-builder` (server, UI in `public/index.html` and `public/flux.js`, rules, drafting, runs, schedules, waiting-run alerts, `src/flux`) · `managed-agents/phase0` (shared environment and vault, sign-in scripts) · `netsuite/` (SDF ACP: role, toolset, field, template) · `scripts/` (doctor, sdf-check) · `tests/netsuite` (toolset guards) · `docs/` (ADRs, builder plan and guide, runbook, release, history).

## Open items when the plan was adopted

The plan decides what happens next; these are kept so nothing is lost. None is started without the owner.

- [ ] Read-only tier: owner assigns it and signs in, vault id into `roles/tiers.json`, then confirm the Clerk sign-in still works (`docs/agent-builder.md`, "Role tiers"). S1's dedicated users (D4) may replace this.
- [ ] Check the vault still reaches NetSuite past the 168-hour refresh limit; if not, re-sign-in and plan a weekly reminder or a "Reconnect NetSuite" button.
- [ ] Delete the test client `nsagent-phase0-test-001` (no connector delete tool: the owner deletes it in the UI, or decides to keep it).
- [ ] Measure several runs at once against the account's concurrency limit before adding more schedules (the plan's S2 is the first measurement).
- [ ] Check how long Anthropic keeps session event history (replaces the CP5 audit retention).
- [ ] Permission review 2027-01-30: Customers = Full was for the gateway's deletes; consider Edit.

### History

CP0 to CP5 passed with owner sign-off (CP5 go-live 2026-10-30); evidence in `docs/cp3-evidence.md`, `docs/cp4-evidence.md`, `docs/cp5-evidence.md`. Phase 0 of Managed Agents passed 2026-10-31 (`docs/phase0-managed-agents.md`); ADR 0007 accepted the same day; builder Phases 1 to 3 merged in #27, #28, #30; the gateway retired at tag `gateway-final`. The owner's mandate of 2026-11-01 listed flux analysis (built), then `docs/plan-finish-the-job.md`, then `docs/plan-item-margin.md`; with this repo frozen (D2), neither plan starts here unless the owner says so.
