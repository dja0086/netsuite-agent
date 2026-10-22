# netsuite-agent

An MCP gateway, a SuiteCloud (SDF) project and a set of agent skills that let an AI agent search, report on and, through approvals, change NetSuite data, inside NetSuite's API limits.

**Status: CP1 and CP2 passed; Phase 3 in progress.** Customer imports and deletes and saved-search saves are live behind approvals (ADRs 0004-0006); custom fields and PDF templates are next. Release procedure: [docs/release.md](docs/release.md). Working with Claude Code: [CLAUDE.md](CLAUDE.md). See the delivery plan for phases and checkpoints.

## Layout

```
apps/mcp-gateway/      MCP server: ns_* tools, skill enforcement, approvals, audit, redaction
packages/ns-client/    The only code that talks to NetSuite: OAuth 2.0 M2M, limiter, retries, SuiteQL paging
packages/suiteql/      Query guards (single SELECT only, literal/identifier helpers)
packages/report-engine/ Report definitions, CSV/XLSX export
packages/import-engine/ CSV mapping and dry run for imports
packages/schemas/      Zod schemas: skill manifests, eval files
netsuite/              SuiteCloud project (ACP): RESTlets, script objects; fields/templates land here via PR
skills/                One folder per skill: SKILL.md, evals/, examples/, CHANGELOG.md, OWNERS
scripts/               doctor, new-skill scaffolder, skills validator, eval runner, release checks, approvals CLI
docs/                  Decision records, release runbook, skill lifecycle, agent evals, Phase 0 findings, role spec
```

## Quick start (local, against a sandbox or demo account)

Requires Node 22+ and pnpm 10.

```bash
node scripts/doctor.mjs        # fix every FAIL first
pnpm install
cp .env.example .env          # fill in IDs only; never a key
# Put the M2M private key OUTSIDE the repo, chmod 600, and point NS_PRIVATE_KEY_PATH at it.
pnpm check                    # typecheck, unit tests, skills validation
```

Run the gateway for an MCP client (stdio):

```bash
set -a; source .env; set +a
pnpm gateway
```

Claude Code picks the gateway up from the repo's `.mcp.json`, which runs `scripts/mcp-gateway.sh` (it loads `.env`, so no IDs or paths go in the JSON). For another MCP client, run `sh /path/to/netsuite-agent/scripts/mcp-gateway.sh` (the script changes to the repo root itself).

## Commands

| Command | What it does |
| --- | --- |
| `pnpm check` | Typecheck, unit tests, skills validation (what CI runs) |
| `pnpm skills:validate` | Skill gate: manifests, declared tools, write-safety evals, owners, changelog, examples, secrets |
| `pnpm skills:eval --mode tools\|agent\|triggers` | Tool cases through the real gateway against `NS_ACCOUNT_ID` (needs `NS_TARGET_KIND` sandbox or demo); agent and trigger cases through the `claude` CLI (docs/agent-evals.md) |
| `pnpm new:skill <name> [--writes]` | Scaffolds a disabled skill, its tool module and a CODEOWNERS line |
| `pnpm gateway` | Starts the MCP gateway on stdio |
| `pnpm ns:ping` | Read-only check of the M2M setup: token, SuiteQL, metadata catalog, explore RESTlet |
| `pnpm contracts:record` | Records sanitized live responses as contract fixtures (sandbox/demo only) |
| `pnpm load:test` | Concurrency and throttling test through one limiter (sandbox/demo only) |
| `pnpm release:check` | Runs every release gate and writes an evidence report (see docs/release.md) |
| `pnpm approvals list\|show\|approve\|deny` | Inspect and decide pending write approvals (local channel) |
| `pnpm doctor` | Checks the toolchain, repo and `.env` |

## Tools

The gateway serves only the tools of enabled skills. Write tools (marked) run only after a named approver approves the exact payload.

| Skill | Tool | Does |
| --- | --- | --- |
| data-explorer | `ns_catalog_list` | Record types visible to the integration role |
| data-explorer | `ns_record_describe` | Field ids, labels, types, custom flag for one record type |
| data-explorer | `ns_suiteql` | One SELECT, up to 200 rows per call, with paging info |
| data-explorer | `ns_record_get` | One record by internal id or `eid:` external id |
| data-explorer | `ns_global_search` | NetSuite global search via the explore RESTlet |
| reports | `ns_report_list`, `ns_report_run`, `ns_report_export_query` | Defined reports, run to CSV/XLSX in `exports/` |
| search-builder | `ns_search_preview` | Preview a saved-search definition |
| search-builder | `ns_search_save` (write) | Save it, after approval |
| data-importer | `ns_import_plan`, `ns_import_dry_run` | Map and check a CSV from `imports/`; no writes |
| data-importer | `ns_import_run` (write) | Create customers from a dry-run-clean CSV, after approval (ADR 0005) |
| data-importer | `ns_record_delete_preview` | Snapshot of customers to delete; no writes |
| data-importer | `ns_record_delete` (write) | Delete up to 25 customers, after approval (ADR 0006) |

## Security model

- OAuth 2.0 client credentials (certificate-signed JWT). No TBA: new TBA integrations are not allowed from NetSuite 2027.1.
- The private key is read at runtime from the secrets backend. The file backend refuses keys stored inside the repo.
- One governance limiter per process caps concurrency (`NS_MAX_CONCURRENCY`) and retries only throttling errors.
- The gateway serves only tools declared by enabled skills. Write tools always go through the approval service (ADR 0004): the approval is bound to a hash of the exact payload and to a named approver, and cannot be replayed.
- Every call is audited as a JSONL line with an input hash; inputs and results are never logged.
- `NS_AGENT_REDACT_FIELDS` masks fields in every result before it reaches the model.

## Adding or improving a skill

Read [docs/skill-lifecycle.md](docs/skill-lifecycle.md). In short: evals first, ship disabled, pass the acceptance table, get the owners' approval.
