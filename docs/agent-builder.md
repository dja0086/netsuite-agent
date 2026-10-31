# Agent builder: how to use it

The agent builder turns a NetSuite use case written in plain language into a Claude Managed Agent on Oracle's NetSuite AI Connector (ADR 0007), then runs it, takes your approvals and schedules it. Plan and results: `docs/agent-builder-plan.md`.

## Start

```bash
pnpm builder
```

Open http://127.0.0.1:5178. It needs `ant auth login` (Anthropic workspace "Default") and the NetSuite vault from Phase 0 (`managed-agents/phase0/`). The page only works on this Mac; reload it after restarting the builder.

## Make an agent

1. Describe the use case and click **Draft agent**. Read the open questions and settle them in the instructions.
2. Adjust the tools: reads run without asking; any write you tick asks every time. Leave writes empty unless the use case changes records.
3. **Create agent.** The fixed rules (right-hand panel) are applied whatever the form says, and checked again before anything is sent.

To change an agent later, click **Edit** on its card (on **For you** or **Agents**) and **Save as new version**. Its schedules move to the new version.

## Run and approve

**Start run** on an agent's card opens the run page: the agent's messages and every tool call as they happen. When a write (or any tool not on the agent's list) is called, the run stops and shows an approval card with the exact request: **Approve** runs it once; **Deny** (with an optional reason) tells the agent no and it carries on. Files the run produces are listed under **Files**. **Runs** lists recent runs. Each run is capped at $5.

## Schedules

**Schedule** on an agent's card: pick weekly, weekdays, daily, monthly or a custom cron, and a time zone. The run message on the card is what each scheduled run is told. The **Schedules** page shows the next and last runs, opens past runs, and has **Run now**, **Pause / Resume** and **Stop** (permanent; use Pause to stop for now). Anthropic may start a run up to 9 minutes after the listed time.

## When a run is waiting for you

A scheduled run that stops for an approval waits until someone decides. Two things tell you:

- The builder's **For you** page: a card per waiting run with **Review**, and a count next to For you in the menu.
- A GitHub issue on dja0086/netsuite-agent titled "NetSuite agent waiting for approval: <agent>", opened by a check that runs every 15 minutes on this Mac. It names the agent and the run only (the repo is public). Open the builder, decide in the run, then close the issue.

The check is a launchd job, installed 2026-10-31:

```bash
launchctl print gui/$(id -u)/com.dja0086.netsuite-agent.builder-pending   # status
tail ~/Library/Logs/netsuite-agent-builder-pending.log                    # what it found
launchctl bootout gui/$(id -u)/com.dja0086.netsuite-agent.builder-pending # remove
```

It runs `apps/agent-builder/scripts/pending-check.sh`; it needs `node`, `gh` (logged in as dja0086) and the `ant` profile. It only looks at runs from the last 14 days and opens at most one issue per run (`apps/agent-builder/data/alerted.json`).

## Local files (git-ignored)

`apps/agent-builder/data/`: `agents.json` (agents you built and their specs), `runs.json`, `schedules.json`, `alerted.json`. If they are lost, the agents and schedules still exist on Anthropic's side but the builder no longer lists them.
