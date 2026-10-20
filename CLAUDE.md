# netsuite-agent: notes for Claude Code

MCP gateway + SuiteCloud project + agent skills that let an AI agent search, report on and (later, with approval) change NetSuite data. Design and delivery plan live in the "NetSuite Agent Monorepo" doc (Architecture & design, Delivery plan tabs). Current phase: **CP1, read-only data explorer**.

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
