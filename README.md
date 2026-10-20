# netsuite-agent

An MCP gateway, a SuiteCloud (SDF) project and a set of agent skills that let an AI agent search, report on and (later, with approval) change NetSuite data, inside NetSuite's API limits.

**Status: Phase 1 (foundation and data explorer).** Release procedure: [docs/release.md](docs/release.md). Working with Claude Code: [CLAUDE.md](CLAUDE.md). Read-only. Writes are refused by the gateway until Phase 2/3 skills ship behind approvals. See the delivery plan for phases and checkpoints.

## Layout

```
apps/mcp-gateway/      MCP server: ns_* tools, skill enforcement, approvals, audit, redaction
packages/ns-client/    The only code that talks to NetSuite: OAuth 2.0 M2M, limiter, retries, SuiteQL paging
packages/suiteql/      Query guards (single SELECT only, literal/identifier helpers)
packages/schemas/      Zod schemas: skill manifests, eval files
netsuite/              SuiteCloud project (ACP): RESTlets, script objects; fields/templates land here via PR
skills/                One folder per skill: SKILL.md, evals/, examples/, CHANGELOG.md, OWNERS
scripts/               new-skill scaffolder, skills validator, eval runner
docs/                  Decision records, skill lifecycle, Phase 0 findings, role spec
```

## Quick start (local, against a sandbox)

Requires Node 22+ and pnpm 10.

```bash
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

Example MCP client entry:

```json
{
  "mcpServers": {
    "netsuite-agent": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/netsuite-agent", "gateway"],
      "env": { "NS_ACCOUNT_ID": "...", "NS_CLIENT_ID": "...", "NS_CERT_ID": "...", "SECRETS_BACKEND": "file", "NS_PRIVATE_KEY_PATH": "/secure/path/ns_m2m.pem" }
    }
  }
}
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm check` | Typecheck, unit tests, skills validation (what CI runs) |
| `pnpm skills:validate` | Skill gate: manifests, declared tools, write-safety evals, owners, changelog, examples, secrets |
| `pnpm skills:eval --mode tools` | Runs every `kind: tool` eval through the real gateway against `NS_ACCOUNT_ID` (needs `NS_TARGET_KIND=sandbox|demo`) |
| `pnpm new:skill <name> [--writes]` | Scaffolds a disabled skill, its tool module and a CODEOWNERS line |
| `pnpm gateway` | Starts the MCP gateway on stdio |
| `pnpm ns:ping` | Read-only check of the M2M setup: token, SuiteQL, metadata catalog, explore RESTlet |
| `pnpm contracts:record` | Records sanitized live responses as contract fixtures (sandbox/demo only) |
| `pnpm load:test` | Concurrency and throttling test through one limiter (sandbox/demo only) |
| `pnpm release:check` | Runs every release gate and writes an evidence report (see docs/release.md) |

## Phase 1 tools (data-explorer skill)

| Tool | Reads |
| --- | --- |
| `ns_catalog_list` | Record types visible to the integration role |
| `ns_record_describe` | Field ids, labels, types, custom flag for one record type |
| `ns_suiteql` | One SELECT, up to 200 rows per call, with paging info |
| `ns_record_get` | One record by internal id or `eid:` external id |
| `ns_global_search` | NetSuite global search via the explore RESTlet |

## Security model

- OAuth 2.0 client credentials (certificate-signed JWT). No TBA: new TBA integrations are not allowed from NetSuite 2027.1.
- The private key is read at runtime from the secrets backend. The file backend refuses keys stored inside the repo.
- One governance limiter per process caps concurrency (`NS_MAX_CONCURRENCY`) and retries only throttling errors.
- The gateway serves only tools declared by enabled skills. Write tools always go through the approval service (deny-all in Phase 1).
- Every call is audited as a JSONL line with an input hash; inputs and results are never logged.
- `NS_AGENT_REDACT_FIELDS` masks fields in every result before it reaches the model.

## Adding or improving a skill

Read [docs/skill-lifecycle.md](docs/skill-lifecycle.md). In short: evals first, ship disabled, pass the acceptance table, get the owners' approval.
