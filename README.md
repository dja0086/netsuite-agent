# netsuite-agent

An agent builder that turns a NetSuite use case written in plain language into a Claude Managed Agent on Oracle's NetSuite AI Connector, with fixed safety rules; plus the SuiteCloud (SDF) project that holds every change to the NetSuite account.

**Status:** the agent builder is in use (Phases 1 to 3 done, `docs/agent-builder-plan.md`). The MCP gateway that came first (checkpoints CP0 to CP5) was retired on 2026-10-31 (ADR 0007); its code is in git history under the tag `gateway-final`. Working with Claude Code: [CLAUDE.md](CLAUDE.md). Operations: [docs/runbook.md](docs/runbook.md).

## Layout

```
apps/agent-builder/    Local web app: draft, create, edit, run, approve and schedule NetSuite agents
managed-agents/phase0/ Shared Managed Agents environment and NetSuite vault (ids in claude-lock.json), sign-in scripts
netsuite/              SuiteCloud project (ACP): integration role, AI Connector toolset, custom field, PDF template
scripts/               doctor (toolchain and setup check), sdf-check (offline SDF checks)
tests/netsuite/        Tests for the toolset's SuiteScript guards
docs/                  Decision records, builder plan and guide, runbook, release (SDF deploys), checkpoint history
```

## Quick start

Requires Node 22+, pnpm 10, the `ant` CLI (logged in) and `gh` (logged in as dja0086).

```bash
node scripts/doctor.mjs        # fix every FAIL first
pnpm install
pnpm check                     # typecheck, builder and toolset tests, offline SDF check
pnpm builder                   # http://127.0.0.1:5178
```

How to make, run, approve and schedule agents: [docs/agent-builder.md](docs/agent-builder.md).

## Security model

- Agents reach NetSuite only through the AI Connector of the demo account, signed in as the role NS Agent Integration. The token lives in a Managed Agents vault; the agent cannot read it.
- Every agent gets the same fixed rules from the builder: NetSuite reads run freely, every write stops for a person to approve the exact request, file writes and UI tools are off, and only the demo account's connector URL is allowed. The builder checks the final configuration again before sending it.
- The record of each run is its session event history (tool calls, decisions, results).
- Account changes ship only as SDF objects through a PR and an approved `deploy-sdf` run (ADR 0002).
