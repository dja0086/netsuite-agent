# CP5 evidence: go-live

Status: **in progress.** CP5 is not passed until the owner signs off.

## Exit criteria

From the Delivery plan: "PII redaction rules, audit retention, rejected-request alerting, permission review, runbook and on-call owner in place." Evidence: runbook link, alert test, sign-off record. Sign-off: sponsor, security and NetSuite admin; on this project that is the owner, dja0086.

Owner decisions (2026-10-30): redact tax and bank ids only; keep audit logs for one year; alert through GitHub issues, on-call owner dja0086; the AI Connector keeps the NS Agent Integration role, with the write-tool risk documented.

| # | Criterion | Where | Result |
| --- | --- | --- | --- |
| 1 | PII redaction rules | `NS_AGENT_REDACT_FIELDS` in `.env` / `.env.example`; `docs/runbook.md`, "Redaction" | In place |
| 2 | Audit retention | Monthly audit files, `pnpm audit:prune` (365 days); `docs/runbook.md`, "Audit retention" | In place |
| 3 | Rejected-request alerting (and failed approvals) | `pnpm audit:alerts --issue`, daily job `scripts/audit-daily.sh`; `docs/runbook.md`, "Alerts" | In place; alert test passed (issue #24) |
| 4 | Permission review | `docs/netsuite-role.md`, "Permission review 2026-10-30 (CP5)" | Done; employee 2815's extra permissions stay (owner decision 2026-10-30) |
| 5 | Runbook and on-call owner | `docs/runbook.md`; on call: dja0086 | In place |
| 6 | Production rollout through change-control | This PR (no NetSuite objects change in CP5) | Pending merge |

## 1. Redaction

Fields: `taxidnum`, `vatregnumber`, `defaulttaxreg`, `accountnumber`, `routingnumber`, `ccnumber`, `socialsecuritynumber`. The gateway applies them to every tool result and to files it writes (existing tests: `gateway.test.ts`, `reports.test.ts`, `data-importer.test.ts`). The AI Connector tools are not redacted (they run inside NetSuite); recorded in the runbook.

## 2. Retention

`JsonlAuditSink` writes each entry to its UTC month's file; `pruneAuditFiles` deletes whole months that ended more than 365 days ago (`apps/mcp-gateway/test/audit.test.ts`). The existing log (115 entries, all October 2026) was moved to `audit/gateway-2026-10.jsonl`. `audit/approvals.sqlite` is kept with no end date.

## 3. Alerting

Rules (`apps/mcp-gateway/src/policy/alerts.ts`, tests in `audit.test.ts`): more than 10% of tool calls rejected over at least 10 calls; any failed approval.

First run on real data (2026-10-30, 240-hour window, report only, no issue opened): 102 calls, 17 rejected (16.7%: `UNEXPECTED_ERROR` 14, `INVALID_PARAMETER` 3, bad SuiteQL from agent trials), 4 refused approval ids (the deliberate replay tests of 2026-10-21/22). Both rules fire as intended.

Alert test (2026-10-30 17:19 UTC, owner-approved): `pnpm audit:alerts --hours 240 --issue` on the real log opened [#24](https://github.com/dja0086/netsuite-agent/issues/24) with the report above (counts, tool names, codes and approval ids only), exit code 1.

Daily job: launchd agent `com.dja0086.netsuite-agent.audit` installed on the owner's Mac (09:00 daily, log `~/Library/Logs/netsuite-agent-audit.log`). First run by `launchctl kickstart`, 2026-10-30 17:20 UTC: prune found nothing older than 365 days; 24-hour window 7 calls, 0 rejected, 0 failed approvals; no issue; exit code 0.

## 4. Permission review

See `docs/netsuite-role.md`. Findings: effective permissions include setup and File Cabinet permissions not in the role XML, probably global permissions on employee 2815, which stay (owner decision 2026-10-30, accepted risk); the AI Connector's Oracle write tools are an accepted, documented risk.

## Sign-off

Pending.
