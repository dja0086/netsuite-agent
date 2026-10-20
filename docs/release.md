# Release runbook

A release is a checkpoint (CP1, CP2, ...) passing on evidence. `pnpm release:check` produces that evidence.

## Targets

| `NS_TARGET_KIND` | Use | Live tests |
| --- | --- | --- |
| `demo` | Test-drive or demo account with no real data (currently TSTDRV1755417) | Allowed |
| `sandbox` | A sandbox of a real company account | Allowed |
| `production` | A real company account | Refused |

The demo account reports itself as `PRODUCTION` to NetSuite; that is its environment type, not its data. Treat it as a sandbox for testing, and keep the integration role read-only until approvals ship.

## One-time setup per machine

```bash
pnpm install
cp .env.example .env                 # NS_ACCOUNT_ID, NS_TARGET_KIND, NS_CLIENT_ID, NS_CERT_ID, NS_PRIVATE_KEY_PATH
set -a; source .env; set +a
pnpm ns:ping                         # must pass before anything else
```

## First release of the explore RESTlet (SDF deploy)

The SuiteCloud CLI needs a JDK (17 or 21). Run these from `netsuite/`:

```bash
suitecloud account:setup             # browser sign-in to the demo account (one time)
suitecloud project:validate --server
suitecloud project:deploy
```

`customrole_ns_agent` must exist first: the RESTlet deployment is restricted to it. After the role exists, import it into the repo (`docs/netsuite-role.md`) so the XML matches the account.

## CP1 release (read-only data explorer)

```bash
pnpm contracts:record                # once; review the fixture diff, then commit it
pnpm release:check                   # offline checks -> ns:ping -> contracts -> tool evals -> load test
```

`release:check` stops at the first failing gate and writes `release-reports/<timestamp>/summary.json` (plus `evals.json`, `load.json`). It flags an uncommitted working tree; commit first so the report names a real commit.

CP1 passes when:

- [ ] `summary.json` shows `"pass": true` on a clean commit
- [ ] Tool evals: 100% of safety cases, at least 90% overall
- [ ] Load test: `peakActive <= maxConcurrency`, `failed: 0`
- [ ] Contract fixtures committed (at least 6)
- [ ] Sign-off: tech lead and skill owner (delivery plan, CP1 row)

## Connecting an agent for a demo

```json
{
  "mcpServers": {
    "netsuite-agent": {
      "command": "pnpm",
      "args": ["--dir", "/Users/<you>/dev/netsuite-agent", "gateway"],
      "env": {
        "NS_ACCOUNT_ID": "TSTDRV1755417",
        "NS_CLIENT_ID": "<client id>",
        "NS_CERT_ID": "<certificate id>",
        "SECRETS_BACKEND": "file",
        "NS_PRIVATE_KEY_PATH": "/Users/<you>/.netsuite-agent/private.pem"
      }
    }
  }
}
```

In Claude Code: `claude mcp add netsuite-agent --scope local -- pnpm --dir "$PWD" gateway` with the variables exported in the shell, or put the JSON above in the project's `.mcp.json` without secrets (IDs only).

## If a gate fails

| Gate | First thing to check |
| --- | --- |
| ns:ping | Account ID, Client ID, Certificate ID; mapping not revoked; role has "Log in using OAuth 2.0 Access Tokens" |
| contract tests | NetSuite changed a response shape: re-record, read the diff, fix ns-client before re-recording blindly |
| tool evals | `evals.json` names the failing case; reproduce with `pnpm skills:eval --mode tools --skill <name>` |
| load test | `failures` in `load.json`; lower `NS_MAX_CONCURRENCY` or raise the integration's allocation |
