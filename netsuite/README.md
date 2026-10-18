# SuiteCloud project (ACP)

Everything deployed into NetSuite by this repo. Deploy only through `.github/workflows/deploy-sdf.yml`.

```
src/
├── manifest.xml, deploy.xml
├── FileCabinet/SuiteScripts/ns_agent/
│   ├── lib/governance.js          # usage-unit and input checks shared by RESTlets
│   └── restlets/explore_rl.js     # read-only global search (Phase 1)
└── Objects/
    ├── customscript_ns_agent_explore_rl.xml
    ├── customrole_ns_agent.xml    # imported from the account (docs/netsuite-role.md)
    ├── fields/                    # generated custom fields arrive here by PR (Phase 3)
    ├── templates/                 # generated PDF templates (Phase 3)
    └── imports/                   # saved CSV import maps (Phase 3)
```

Local validation (needs `npm i -g @oracle/suitecloud-cli` and `suitecloud account:setup` against the sandbox):

```bash
suitecloud project:validate --server
```

Prerequisite: the role `customrole_ns_agent` must exist in the target account before the first deploy, because the RESTlet deployment is restricted to it.
