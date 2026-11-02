# Agent builder: how to use it

The agent builder turns a NetSuite use case written in plain language into a Claude Managed Agent on Oracle's NetSuite AI Connector (ADR 0007), then runs it, takes your approvals and schedules it. Plan and results: `docs/agent-builder-plan.md`.

## Start

```bash
pnpm builder
```

Open http://127.0.0.1:5178. It needs `ant auth login` (Anthropic workspace "Default") and the NetSuite vault from Phase 0 (`managed-agents/phase0/`). The page only works on this Mac; reload it after restarting the builder.

## Make an agent

1. Describe the use case and click **Draft agent**. Read the open questions and settle them in the instructions.
2. Check **Runs as** (the role tier, below) and the tools: reads run without asking; any write you tick asks every time and must be allowed by the tier. Leave writes empty unless the use case changes records.
3. **Create agent.** The fixed rules (right-hand panel) are applied whatever the form says, and checked again before anything is sent.

To change an agent later, click **Edit** on its card (on **For you** or **Agents**) and **Save as new version**. Its schedules move to the new version.

## Role tiers

Agents don't get a NetSuite role each. They share a few **tiers**, and each tier is one NetSuite role with one sign-in. **Runs as** on the agent form picks the tier. The builder refuses write tools the tier does not list, and checks that again before anything is sent.

| Tier | NetSuite role | Writes it allows (each still waits for approval) |
| --- | --- | --- |
| Read-only | NS Agent - Read-only (`customrole_nsagent_read`) | None |
| Clerk | NS Agent Integration (`customrole_ns_agent`) | `createCustomer`, `updateCustomer`, `ns_createRecord`, `ns_updateRecord` |

Everything about the tiers lives in `roles/tiers.json`: permissions (a shared base plus each tier's changes), the write tools each tier allows, and the vault holding each tier's sign-in.

**Change a permission or add a tier:** edit `roles/tiers.json`, run `node scripts/roles.mjs` (it writes the role files in `netsuite/src/Objects/`), open a PR, then deploy with `deploy-sdf`. CI fails if a role file and `tiers.json` disagree, or if a tier without write tools has more than View on a record.

**Sign a tier in (once per tier, not per agent):**

1. Owner, in NetSuite: give employee 2815 the tier's role (Setup > Users/Roles > Manage Users > the employee > Access > Roles).
2. Owner: with `NS_BUILDER_CLIENT_ID` and `NS_BUILDER_CLIENT_SECRET` (integration 209) set in the shell, run `npx tsx managed-agents/phase0/scripts/ns-signin.mts "NS Agent - Read-only"`. On NetSuite's login page, choose that role.
3. Create a vault for the tier: `ant beta:vaults create --display-name "NetSuite - Read-only"`. Then store the sign-in in it: `npx tsx managed-agents/phase0/scripts/vault-store.mts <vlt_…> "NS Agent - Read-only"`. Both scripts print no secrets. Delete the token file afterwards (`managed-agents/phase0/scripts/tokens.json`).
4. Put the vault id in the tier's `vault` in `roles/tiers.json`, then restart the builder.

The first extra sign-in also tests something Oracle's docs don't cover. Clerk's agents use the same integration (209) under another role, and it's not documented whether a second sign-in replaces the first. So right after it, start a run of a Clerk agent. If it fails to sign in, the Clerk tier needs its own integration record.

Agents made before tiers existed run as Clerk, the sign-in they always used. To move one to Read-only, edit it, pick Read-only and save; its schedules move to the new vault too.

## Run and approve

**Start run** on an agent's card opens the run page: the agent's messages and every tool call as they happen. When a write (or any tool not on the agent's list) is called, the run stops and shows an approval card with the exact request: **Approve** runs it once; **Deny** (with an optional reason) tells the agent no and it carries on. Files the run produces are listed under **Files**. **Runs** lists recent runs. Each run is capped at $5.

## Schedules

**Schedule** on an agent's card: pick weekly, weekdays, daily, monthly or a custom cron, and a time zone. The run message on the card is what each scheduled run is told. The **Schedules** page shows the next and last runs, opens past runs, and has **Run now**, **Pause / Resume** and **Stop** (permanent; use Pause to stop for now). Anthropic may start a run up to 9 minutes after the listed time.

## Flux analysis

**Flux** in the menu prepares a period-over-period variance review. Design and its evidence: `docs/flux-design.md`.

1. Load the periods once, set your **threshold policy**, then pick a period and comparison and click **Prepare flux**. It takes about two minutes and reads NetSuite through the "Flux data reader" agent, which appears under Agents and Runs. It runs fixed read-only queries and has every write tool disabled.
2. The page opens on what moved net income: a bridge and the accounts that need an explanation, riskiest first. Check the basis chips, including that it ties to the ledger total. The line under the table says what fell below your threshold.
3. Click an account. **Explanation** shows drivers priced from the transactions they cite, what's left untraced, whether each cause is stated in the record, inferred or unknown, and the question to ask the owner. **Breakdown** pivots by subsidiary, department, class, location, client or vendor, and item. **Transactions** links to the records in NetSuite. **History** is the trail.
4. Write what the owner told you and **Sign off as preparer**. A reviewer then **Approves** or **Sends back** with a note. Approval locks the explanation until it is reopened with a reason.
5. **Re-read ledger** fetches current postings. If an account's postings changed, its explanation is marked out of date and its sign-offs reopen. **Evidence packet** downloads a CSV with basis, tie-out, thresholds and changes to them, drivers, citations and the sign-off trail.

Changing a threshold on a prepared flux needs a reason, which goes in the packet. **Signing as** is typed, not a login: it isn't a control until the builder has real sign-in. Saved in `apps/agent-builder/data/flux/` (git-ignored).

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
