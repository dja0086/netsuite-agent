# Operations runbook

How to run, watch and fix the NS Agent in day-to-day use. Releases and deploys are in `docs/release.md`; the role and its review are in `docs/netsuite-role.md`.

## On call

| Role | Who | Reached by |
| --- | --- | --- |
| On-call owner | dja0086 (Dominick Amirr) | GitHub notifications on dja0086/netsuite-agent (alert issues) |
| NetSuite admin | dja0086 | same |

Owner decision 2026-10-30. When the team grows, name a backup here.

## What runs where

| Part | Where | Runs as | Logs |
| --- | --- | --- | --- |
| MCP gateway (`pnpm gateway`, started by `.mcp.json` through `scripts/mcp-gateway.sh`) | The owner's Mac | Employee 2815 with role NS Agent Integration, M2M certificate (integration record "NS Agent Gateway", id 207) | `audit/gateway-YYYY-MM.jsonl` (one line per call: tool, outcome, latency, input hash; never inputs or results) |
| Approvals (ADR 0004) | `audit/approvals.sqlite`, decided with `pnpm approvals` | Named approvers in `NS_AGENT_APPROVERS` | `approval.*` events in the audit log |
| RESTlets, PDF template, custom field, toolset | NetSuite TSTDRV1755417, deployed by `deploy-sdf` | The calling role | NetSuite script execution logs |
| AI Connector custom tools (`nsagent_suiteql`, `nsagent_record_get`) | NetSuite, reached through a claude.ai custom connector on `/services/mcp/v1/all` | Whoever signs in; the owner signs in as NS Agent Integration | Script execution log of the toolset; Login Audit Trail. **Not** in the gateway audit log. |
| Daily audit job (`scripts/audit-daily.sh`) | The owner's Mac, launchd, 09:00 | The owner | `~/Library/Logs/netsuite-agent-audit.log` |

## Redaction

The gateway masks these fields as `[REDACTED]` in every tool result and in files it writes (`NS_AGENT_REDACT_FIELDS`, owner decision 2026-10-30): `taxidnum`, `vatregnumber`, `defaulttaxreg`, `accountnumber`, `routingnumber`, `ccnumber`, `socialsecuritynumber`. Matching ignores case, so REST names such as `vatRegNumber` are covered. Emails, phones and addresses are not masked: imports and reports use them.

The AI Connector tools run inside NetSuite and do not pass through the gateway, so they are **not** redacted; what they return is limited only by the role.

To add a field: append it to `NS_AGENT_REDACT_FIELDS` in `.env` and `.env.example`, restart the gateway, and record the decision here.

## Audit retention

- Entries are written to monthly files (`audit/gateway-2026-10.jsonl`). They are kept for **365 days** (owner decision 2026-10-30).
- `pnpm audit:prune` deletes monthly files whose month ended more than 365 days ago. The daily job runs it.
- `audit/approvals.sqlite` is kept with no end date: it is the record of who approved each write.
- The `audit/` folder is git-ignored and lives only on the owner's Mac. Back it up with the rest of the machine.

## Alerts

`pnpm audit:alerts [--hours 24] [--issue]` reads the audit log for the window and fires when:

- **Rejected-request ratio:** more than 10% of tool calls failed, over at least 10 calls. A rejection is any failed call except bad input (`INVALID_INPUT`) or a pending approval: NetSuite errors (throttling, permissions, query errors), refused writes, internal errors.
- **Failed approval:** any denied approval, any refused approval id (wrong payload, expired, replayed), or any approved write that then failed.

The daily job runs it with `--issue`, which opens an issue on `NS_AGENT_ALERT_REPO` (dja0086/netsuite-agent) holding counts, tool names, error codes and approval ids only. The repo is public: never paste inputs or results into the issue.

### When an alert issue opens

1. Run `pnpm audit:alerts --hours 24` locally to see the same report.
2. Rejected ratio, by error code:
   - `HTTP_429`, `CONCURRENCY_LIMIT_EXCEEDED`: throttling. Check Setup > Integration > Web Services Usage Log and the integration's concurrency slice; lower `NS_MAX_CONCURRENCY` if other integrations share the account.
   - `HTTP_401`, `INVALID_LOGIN`, token errors: run `pnpm ns:ping`, then SuiteQL `SELECT date, status, detail FROM loginaudit WHERE oauthappname = 'NS Agent Gateway'`. Common causes: the M2M mapping was revoked, the certificate expired, the role lost "Log in using OAuth 2.0 Access Tokens".
   - `INSUFFICIENT_PERMISSION`, `HTTP_403`: a role change. Compare the account with `customrole_ns_agent.xml` (`suitecloud object:import`, review the diff).
   - `INVALID_PARAMETER`, `UNEXPECTED_ERROR` on `ns_suiteql`: usually bad queries from the agent. If they cluster on one query shape, check NetSuite release notes for SuiteQL table or field changes.
   - `INTERNAL_ERROR`: the gateway's stderr has the stack; reproduce with the same tool locally.
3. Failed approval: `pnpm approvals show <approvalId>`. A denial or a refused replay is expected behaviour, but confirm nobody retried a write with a changed payload. An approved write that failed: check the record in NetSuite; nothing is retried automatically.
4. Write what you found as a comment on the issue and close it.

## Scheduled checks

Install the daily job once per machine (owner's Mac):

```bash
cat > ~/Library/LaunchAgents/com.dja0086.netsuite-agent.audit.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.dja0086.netsuite-agent.audit</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$PWD/scripts/audit-daily.sh</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/netsuite-agent-audit.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/netsuite-agent-audit.log</string>
</dict></plist>
PLIST
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dja0086.netsuite-agent.audit.plist
```

Run it from the repo root (`$PWD` is written into the file). `node` and `gh` must be on that `PATH`, and `gh` must be logged in as dja0086. Test it now with `launchctl kickstart gui/$(id -u)/com.dja0086.netsuite-agent.audit`, then read the log. Remove it with `launchctl bootout gui/$(id -u)/com.dja0086.netsuite-agent.audit`.

## AI Connector

- Endpoint: `https://tstdrv1755417.suitetalk.api.netsuite.com/services/mcp/v1/all`, as the claude.ai custom connector "NetSuite All". The built-in "NetSuite" connector uses the Standard Tools SuiteApp URL and does not show our tools.
- Sign in as **NS Agent Integration**. The role is fixed per OAuth consent: to change it, revoke the consent (Setup > Users/Roles > OAuth 2.0 Authorized Applications) and sign in again.
- `/all` also offers Oracle's write tools. Do not call them; they bypass approvals (`docs/netsuite-role.md`, review finding 2). **Disconnect "NetSuite All" in claude.ai when you are not using it.**
- Never sign in to "United Refractories - NetSuite" (account 9173162, a real production account) from this project.

## Credentials and expiry

| Item | Where | Expires / rotate |
| --- | --- | --- |
| Gateway M2M certificate (mapping jxqM14Kc…) | Key at `NS_PRIVATE_KEY_PATH`, outside the repo | Check the certificate's end date in Setup > Integration > OAuth 2.0 Client Credentials (M2M) Setup; rotate by adding a new mapping before revoking the old one. Never re-run the openssl command over the live key. |
| CI deploy certificate | `~/.netsuite-agent/sdf-ci/`, GitHub secret `NS_PROD_SDF_PRIVATE_KEY` in environment `production` | 2027-10-23; rotate a month earlier |
| `gh` login (dja0086) | macOS keychain | Alerts and the GitHub approval channel stop working if it lapses |

## NetSuite releases

Twice a year, when TSTDRV1755417 moves to a new release: read the release notes for SuiteQL, REST Record API and AI Connector changes; then run `pnpm release:check` and the CP4 parity cases (`docs/cp4-parity-results.md`). Re-record contract fixtures only after reading their diff.

## Quarterly

- Permission review of `customrole_ns_agent` and employee 2815's global permissions (`docs/netsuite-role.md`; next 2027-01-30).
- Close or act on any open alert issues.
- Check the expiry table above.
