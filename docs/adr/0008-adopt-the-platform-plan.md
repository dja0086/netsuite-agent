# ADR 0008: Adopt the platform plan; autonomous writes supersede the no-write rule; this repo is frozen

**Status:** accepted · 2026-11-14 by the owner (platform checkpoint S0) · supersedes the rule "Never write to NetSuite outside an approved agent run" in `CLAUDE.md`, and the "one login for every agent" decision of 2026-10-21. ADR 0007 stays in force for how this repo's builder works today.

## Context

This repo's working rule was that NetSuite data changes happen only when a builder agent calls a write tool and the owner approves that exact call on the run page (ADR 0007, `CLAUDE.md`). On 2026-11-14 the owner accepted the Hardened plan for the NetSuite agent platform, kept in the platform repo `suitereact-mcp`: [plan](https://github.com/dja0086/suitereact-mcp/blob/main/docs/platform/plan.md) and [build brief](https://github.com/dja0086/suitereact-mcp/blob/main/docs/platform/build-brief.md). In it, agents write to production in the pilot account, and four hard gates always need a person. The plan's ADR 5 (`docs/adr/0005-adopt-the-hardened-plan.md` in `suitereact-mcp`) records the decisions in full.

## Decision

1. **The plan governs.** When sources disagree, the order is: the owner's instruction, then the plan, then ADRs, then a repo's context file, then skills.
2. **The no-write rule is retired (L2).** Unattended agents will write through the platform's tool runner over M2M from checkpoint S2 (D1, D3); hard-gated actions (GL-impacting postings, roles and access, code deployments, deletes and mass updates) run only from an approved Agent Proposal, executed as the approver, from S3 (L3, D5). Connector write tools are never a write path from Claude Code (build brief rule 9). Until S2, this repo's builder keeps its existing approval flow unchanged.
3. **This repo is frozen (D2).** Its role tiers (`roles/tiers.json`, the role XML) move to `suitereact-mcp` in S1; after S1 it takes no new work. The builder's fixed rules (`src/rules.ts`, `src/catalog.ts`) are not changed by S0.
4. **Dedicated agent users (D4).** Each role tier gets a dedicated agent user in S1, so System Notes name the agent. This reopens the 2026-10-21 decision to use the owner's own login.
5. **Public, scrubbed (D7).** The repo stays public. S0 removes the client name and the production account ID from every tracked file (one guard test now uses a fictional ID and keeps its meaning) and removes live resource IDs (NetSuite internal IDs; Managed Agents agent, environment, vault and session IDs) from the docs. The pilot account ID and the IDs in the lock and tier files stay in runtime code and config. **Owner's ruling of 14 Nov 2026, relayed by the lead session:** the pilot account ID is scrubbed from the docs as well ("the pilot account" instead), and stays only where the running code or its config needs it. Old commits keep everything.
6. **Identifier scan (I9).** `.github/workflows/identifier-scan.yml` scans the current tree, never history, and fails any new account ID, account hostname or Managed Agents ID, plus the literal strings in the optional `IDENTIFIER_DENYLIST` Actions secret. Files that still hold identifiers are baselined by path and count, never by value. The existing gitleaks history scan is unchanged.
7. **Account facts come from a query (I10).** `CLAUDE.md` keeps rules and decisions; record counts, internal IDs, role IDs and deployment statuses come from a query at session start.

The locked decisions L1 to L8 and decisions D1 to D7 are listed, with their reasons, in the plan.

## Consequences

- `CLAUDE.md` is rewritten: the retired rule is replaced by a pointer to the plan and this ADR, and its hand-kept account facts are gone.
- Branch protection on `main` still requires the existing checks; the identifier scan is not yet a required check. Adding it is the owner's choice (repository settings).
- The ADRs 0001 and 0003 to 0006 remain history, as ADR 0007 says.
