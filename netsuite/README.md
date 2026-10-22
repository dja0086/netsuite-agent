# SuiteCloud project (ACP)

Everything deployed into NetSuite by this repo. Changes reach the account only through a reviewed PR (ADR 0002).

How deploys run today: locally from this folder with SuiteCloud auth ID `nsagent-demo`, against the demo account TSTDRV1755417. Before every deploy, run `suitecloud account:manageauth --info nsagent-demo` and confirm the Account ID (an early setup once linked the wrong account). `.github/workflows/deploy-sdf.yml` becomes the only deploy path once its sandbox and production environments are configured on dja0086 (Phase 3).

```
src/
├── manifest.xml, deploy.xml
├── FileCabinet/SuiteScripts/ns_agent/
│   ├── lib/governance.js          # usage-unit and input checks shared by RESTlets
│   └── restlets/
│       ├── explore_rl.js          # read-only global search
│       └── search_rl.js           # saved-search preview and approved save
└── Objects/
    ├── customrole_ns_agent.xml    # imported from the account (docs/netsuite-role.md)
    ├── customscript_ns_agent_explore_rl.xml
    ├── customscript_ns_agent_search_rl.xml
    ├── fields/                    # generated custom fields arrive here by PR (Phase 3)
    └── templates/                 # generated PDF templates (Phase 3)
```

Customer imports do not use saved CSV import maps: they go through the REST Record API behind approvals (ADR 0005).

Local validation (needs the SuiteCloud CLI and a JDK; `node scripts/doctor.mjs` checks both):

```bash
suitecloud project:validate --server
```

Prerequisite: the role `customrole_ns_agent` must exist in the target account before the first deploy, because the RESTlet deployments are restricted to it.
