# SuiteCloud project (ACP)

Everything deployed into NetSuite by this repo. Changes reach the account only through a reviewed PR (ADR 0002).

How deploys run:

- **Pipeline:** `.github/workflows/deploy-sdf.yml`, started by hand from main. It deploys one commit that is on main to the one account, the demo account TSTDRV1755417 (GitHub environment `production`), after one approval in GitHub's environment review; it server-validates, deploys and uploads its logs. Owner decision 2026-10-25: one environment, one approval, no sandbox. Setup, approval and rollback: `docs/release.md` ("SDF deploy pipeline").
- **Locally, until then:** from this folder with SuiteCloud auth ID `nsagent-demo`. Before every deploy, run `suitecloud account:manageauth --info nsagent-demo` and confirm the Account ID (an early setup once linked the wrong account).

Deploys never delete: an object or file removed from this project stays in the account until an admin deletes it in NetSuite (see Rollback in `docs/release.md`).

```
src/
├── manifest.xml, deploy.xml
├── FileCabinet/SuiteScripts/ns_agent/
│   ├── lib/tool_guards.js         # input guards for the custom tools (tests in tests/netsuite)
│   └── tools/
│       ├── agent_tools.js         # nsagent_suiteql, nsagent_record_get (N/query only)
│       └── agent_tools_schema.json
└── Objects/
    ├── customrole_ns_agent.xml    # imported from the account (docs/netsuite-role.md)
    ├── custtoolset_nsagent_read.xml  # AI Connector toolset; builder agents use nsagent_suiteql
    ├── fields/                    # custom fields, by PR
    └── templates/                 # Advanced PDF/HTML templates, by PR
```

The explore, search and PDF preview RESTlets (`Objects/customscript_ns_agent_*_rl.xml`, `restlets/`, `lib/governance.js`, `lib/resource_scan.js`) belonged to the retired MCP gateway (ADR 0007, tag `gateway-final`). Deploys never delete, so they stay in the repo with each script inactive and its deployment off, which keeps the account matching the repo. Do not reactivate them.

Checks:

```bash
pnpm sdf:check                # offline, no account: XML, script IDs, file references, SuiteScript syntax (runs in CI on every PR)
suitecloud project:validate   # on the server with the default auth ID; CLI 4.1.1 has no offline validation (--server is ignored)
```

The server validation needs the SuiteCloud CLI and a JDK (`node scripts/doctor.mjs` checks both).

Prerequisite: the role `customrole_ns_agent` must exist in the target account before the first deploy; the toolset's visibility depends on the role's permissions.
