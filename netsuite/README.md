# SuiteCloud project (ACP)

Everything deployed into NetSuite by this repo. Changes reach the account only through a reviewed PR (ADR 0002).

How deploys run:

- **Pipeline:** `.github/workflows/deploy-sdf.yml`, started by hand from main. It deploys one commit that is on main through stage 1 (`sandbox`) and stage 2 (`production`); each stage needs approval in GitHub's environment review (the control, enforced by GitHub, possible because the repo is public) and an approval comment on a GitHub issue (audit trail), then server-validates, deploys and uploads its logs. Under the owner's decision of 2026-10-22 **both stages point at the demo account TSTDRV1755417**: this rehearses the path for CP3 and is not a production deploy. Setup checklist, approvals and rollback: `docs/release.md` ("SDF deploy pipeline"). Until the checklist is done (protections first, then credentials), the pipeline fails at its first check and deploys stay local.
- **Locally, until then:** from this folder with SuiteCloud auth ID `nsagent-demo`. Before every deploy, run `suitecloud account:manageauth --info nsagent-demo` and confirm the Account ID (an early setup once linked the wrong account).

Deploys never delete: an object or file removed from this project stays in the account until an admin deletes it in NetSuite (see Rollback in `docs/release.md`).

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

Checks:

```bash
pnpm sdf:check                # offline, no account: XML, script IDs, file references, SuiteScript syntax (runs in CI on every PR)
suitecloud project:validate   # on the server with the default auth ID; CLI 4.1.1 has no offline validation (--server is ignored)
```

The server validation needs the SuiteCloud CLI and a JDK (`node scripts/doctor.mjs` checks both).

Prerequisite: the role `customrole_ns_agent` must exist in the target account before the first deploy, because the RESTlet deployments are restricted to it.
