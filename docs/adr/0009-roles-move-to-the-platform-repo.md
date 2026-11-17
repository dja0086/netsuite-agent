# ADR 0009: Role definitions move to the platform repo; one agent user for the platform

**Status:** accepted with platform checkpoint S1 (amendments A13 and A21 of the [platform plan](https://github.com/dja0086/suitereact-mcp/blob/main/docs/platform/plan.md)) · 2026-11-17 · amends decisions 3 and 4 of ADR 0008.

## Context

ADR 0008 recorded that this repo's role tiers would move to the platform repo `suitereact-mcp` in S1, and that each tier would get a dedicated agent user (D4).

The plan's amendment A13 says the platform repo becomes the only place role objects are generated and deployed from. The role objects, generator and CI step leave this repo, which keeps only the tier-to-vault map its builder reads at run time.

On 16 November 2026 the owner changed D4 with amendment A21: one dedicated agent user with one agent role for now, not one user per tier. The other role objects, including this repo's two, keep their files in the platform repo, get no user, and are covered by its live-role check. That decision is recorded in the platform repo's ADR 7 (`docs/adr/0007-one-agent-user.md`).

## Decision

1. **Role definitions live in the platform repo.**
   - `netsuite/src/Objects/customrole_ns_agent.xml`, `customrole_nsagent_read.xml` and `scripts/roles.mjs` are removed here, with the CI step and the `roles` package script that ran the generator.
   - Both roles are defined in `suitereact-mcp` under `sdf/objects/role/`, and the owner deploys them from there.
   - `deploy-sdf` here no longer deploys a role.
2. **The SDF project depends on the role instead of defining it.** `netsuite/src/manifest.xml` lists `customrole_ns_agent` as an object dependency, because three RESTlet deployments restrict their audience to it.
3. **`roles/tiers.json` is the tier-to-vault map.**
   - It keeps each tier's ID, label, role, write tools and vault, which `apps/agent-builder/src/tiers.ts` and the sign-in script read.
   - The permissions and the shared base are gone.
4. **D4 as changed by A21.**
   - The platform has one agent user with one agent role, `customrole_sr_agent_proposer`.
   - This repo's tiers are not moved onto that user: they still sign in as the owner's login (ADR 0007). The owner accepted this as an exception for the frozen repo on 2026-11-17, in the platform builder's session, until a later checkpoint replaces this builder. It is not a reading of D4 for any new agent.
   - This repo is frozen (D2), and its builder is replaced in later checkpoints.

## Consequences

- A permission change for the Clerk or Read-only role is a pull request in `suitereact-mcp`, under its checkpoint rules, and the owner deploys it from there.
- The live permissions of `customrole_ns_agent` are what the platform repo's file says, and its by-hand live-role check confirms it (A23). The table in `docs/netsuite-role.md` is a historical setup record.
- The decision 4 text in ADR 0008 ("each role tier gets a dedicated agent user in S1") no longer describes the plan; this ADR does.
