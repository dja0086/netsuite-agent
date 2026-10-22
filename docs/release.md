# Release runbook

A release is a checkpoint (CP1, CP2, ...) passing on evidence. `pnpm release:check` produces that evidence.

## Targets

| `NS_TARGET_KIND` | Use | Live tests |
| --- | --- | --- |
| `demo` | Test-drive or demo account with no real data (currently TSTDRV1755417) | Allowed |
| `sandbox` | A sandbox of a real company account | Allowed |
| `production` | A real company account | Refused |

The demo account reports itself as `PRODUCTION` to NetSuite; that is its environment type, not its data. Treat it as a sandbox for testing. Since CP3 the integration role can create and delete customers, but only through approved tool calls (ADR 0004-0006).

## One-time setup per machine

```bash
node scripts/doctor.mjs --tools-only   # fix every FAIL before going on
pnpm install
cp .env.example .env                 # NS_ACCOUNT_ID, NS_TARGET_KIND, NS_CLIENT_ID, NS_CERT_ID, NS_PRIVATE_KEY_PATH
set -a; source .env; set +a
pnpm ns:ping                         # must pass before anything else
```

## SDF deploys (RESTlets, role)

The SuiteCloud CLI needs a JDK (17 or 21). Run these from `netsuite/`:

```bash
suitecloud account:setup                        # browser sign-in to the demo account (one time; auth ID nsagent-demo)
suitecloud account:manageauth --info nsagent-demo  # every time: confirm the Account ID is TSTDRV1755417
suitecloud project:validate --server
suitecloud project:deploy
```

The first `account:setup` once linked a different (production) account, which is why the Account ID check comes before every deploy. Deployed so far: the role, the explore RESTlet and the search RESTlet. Deploys run locally until `deploy-sdf.yml` has its environments on dja0086 (Phase 3).

`customrole_ns_agent` must exist first: the RESTlet deployment is restricted to it. After the role exists, import it into the repo (`docs/netsuite-role.md`) so the XML matches the account.

## Checkpoint release (`release:check`)

```bash
pnpm contracts:record                # once; review the fixture diff, then commit it
pnpm release:check                   # offline checks -> ns:ping -> contracts -> tool evals -> trigger evals -> load test
```

`release:check` stops at the first failing gate and writes `release-reports/<timestamp>/summary.json` (plus `evals.json`, `triggers.json`, `load.json`). It flags an uncommitted working tree; commit first so the report names a real commit.

A checkpoint's automated part passes when (CP1 passed on 658a44d; the latest full run passed on 4810a2d; each checkpoint's own exit criteria are in the delivery plan):

- [ ] `summary.json` shows `"pass": true` on a clean commit
- [ ] Tool evals: 100% of safety cases, at least 90% overall
- [ ] Load test: `peakActive <= maxConcurrency`, `failed: 0`
- [ ] Contract fixtures committed (at least 6)
- [ ] Sign-off by the people named in the delivery plan's checkpoint row

## Connecting an agent for a demo

Claude Code: open the repo; its `.mcp.json` starts the gateway through `scripts/mcp-gateway.sh`, which loads `.env` (IDs only; the key stays at `NS_PRIVATE_KEY_PATH`). Other MCP clients: run `sh /path/to/netsuite-agent/scripts/mcp-gateway.sh` as a stdio server. Never put the client secret, key or key path into a client's JSON config.

Writes need an approver: with the local channel, decide pending approvals with `pnpm approvals list|show|approve|deny`.

## If a gate fails

| Gate | First thing to check |
| --- | --- |
| ns:ping | Account ID, Client ID, Certificate ID; mapping not revoked; role has "Log in using OAuth 2.0 Access Tokens" |
| contract tests | NetSuite changed a response shape: re-record, read the diff, fix ns-client before re-recording blindly |
| tool evals | `evals.json` names the failing case; reproduce with `pnpm skills:eval --mode tools --skill <name>` |
| trigger evals | `FAIL` lines in the output and `triggers.json`; a prompt routed to the wrong skill means a skill description or trigger prompt needs fixing. Needs the `claude` CLI logged in. |
| load test | `failures` in `load.json`; lower `NS_MAX_CONCURRENCY` or raise the integration's allocation |
