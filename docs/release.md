# Release runbook

How account changes reach NetSuite: SDF objects in `netsuite/`, merged by PR and deployed by `deploy-sdf` with one approval (ADR 0002). The checkpoint gates (`release:check`, contract fixtures, skill evals, load test) belonged to the MCP gateway, retired 2026-10-31 (ADR 0007); they remain in git history under the tag `gateway-final`.

## Targets

| `NS_TARGET_KIND` | Use | Deploys and live tests |
| --- | --- | --- |
| `demo` | Test-drive or demo account with no real data (currently TSTDRV1755417) | Allowed |
| `sandbox` | A sandbox of a real company account | Allowed |
| `production` | A real company account | Refused |

The demo account reports itself as `PRODUCTION` to NetSuite; that is its environment type, not its data. Treat it as a sandbox for testing.

## One-time setup per machine

```bash
node scripts/doctor.mjs              # fix every FAIL before going on
pnpm install
pnpm check                           # typecheck, builder and toolset tests, offline SDF check
```

## SDF deploy pipeline (`deploy-sdf.yml`)

Account changes (roles, scripts, custom fields, PDF templates) ship only as SDF objects in `netsuite/`, merged to main through a PR (ADR 0002), then deployed by `.github/workflows/deploy-sdf.yml`.

> **One account, one environment, one approval.** Owner decision 2026-10-25: this project has one NetSuite account, the demo account TSTDRV1755417, and no sandbox. The workflow deploys to it through the GitHub environment `production`, after one approval. (This replaces the two-stage sandbox → production design of 2026-10-22; for CP3, "PR to sandbox to production" becomes "PR to the one account, approved".) When real accounts exist, add an environment per account.

### What runs where

| Where | What | Account access |
| --- | --- | --- |
| Every PR and push to main (`ci.yml`, job `sdf-check`) | `scripts/sdf-check.mjs` (`pnpm sdf:check`, also part of `pnpm check`): well-formed XML, object file name = `scriptid`, no duplicate script IDs, every `[/SuiteScripts/...]` file present, each `advancedpdftemplate` has its `.template.xml`, `node --check` on every SuiteScript file. Then `suitecloud project:package` with the pinned CLI. | None, no secrets |
| `deploy-sdf.yml`, started by hand (Actions → deploy-sdf → Run workflow, from main) | resolve `ref` → **approval** → authenticate → confirm the account → `project:validate` (server) → `project:deploy` | M2M certificate in environment `production` |

Why PRs do not run `suitecloud project:validate`: in SuiteCloud CLI 4.1.1 validation always runs on the server (`--server` is accepted and ignored) and needs an auth ID, so it cannot run without account credentials. `project:package` does no validation either. The server validation runs in the deploy job before the deploy; `validate_only: true` runs only that, without deploying.

Pipeline details:

- **Pinned toolchain** (`.github/actions/suitecloud-setup`): Node 24 LTS (what the CLI supports), Temurin JDK 21, `@oracle/suitecloud-cli@4.1.1` (what runs locally). Change versions there only.
- **One commit per run.** `ref` (branch, tag or SHA) is resolved once to a SHA. The run fails unless that SHA is reachable from `origin/main` and the workflow itself was started from main. The deploy job checks out that SHA, so a merge to main while the approval waits changes nothing.
- **One deploy at a time.** `concurrency: deploy-sdf` without cancelling; GitHub keeps one more run pending behind the running one, and a newer dispatch replaces the pending run.
- **Auth ID.** CLI 4.1.1 has no `--authid` on `project:validate` or `project:deploy`; both read `defaultAuthId` from `netsuite/project.json` (git-ignored). The job runs `account:setup:ci` with auth ID `ns-agent-production`, writes `project.json` with it, and stops unless `account:manageauth --info` reports the account in `NS_PROD_ACCOUNT_ID`. CI mode needs `SUITECLOUD_CI=1` and a `SUITECLOUD_CI_PASSKEY`; the job generates a random passkey that lives only for that job.
- **Key handling.** The PEM is written to `$RUNNER_TEMP` with `umask 077` (outside the workspace), and an `if: always()` step deletes it, `project.json` and the stored CI credentials.
- **Evidence.** The job uploads `sdf-production-<sha>` (validate and deploy logs and console output, kept 90 days); the run page records who approved it.

### Approval

**The repo is public (owner decision 2026-10-23)**, so GitHub's environment protection applies on the free plan. Environment `production` requires approval from `dja0086` (Review deployments on the run page) before the job starts or can read its secrets, and accepts only protected branches (`main`). GitHub enforces both, so editing the workflow on a branch cannot skip them. With a single owner, the person who starts the run also approves it (`prevent_self_review` is off); add a second reviewer when there is one.

> **Rule: the deploy secret lives only in the `production` environment, never at repository level.** A repository secret is readable by any workflow on any branch, which is exactly what the environment rules prevent.
>
> **Before making the repo private again**, upgrade to a plan that supports environment protection for private repositories (GitHub Team or Enterprise), or delete the deploy secret first. On a free private repo the environment rules stop applying.

### Setup (done 2026-10-25)

- [x] Branch protection on `main`: a pull request with the checks `checks`, `secret-scan` and `sdf-check`; no force pushes or deletion.
- [x] Environment **`production`**: required reviewer `dja0086`; deployment branches = protected branches only.
- [x] CI key pair in `~/.netsuite-agent/sdf-ci/` (separate from the retired gateway's key). Made with OpenSSL 3:
  ```bash
  mkdir -p ~/.netsuite-agent/sdf-ci && cd ~/.netsuite-agent/sdf-ci && openssl req -new -x509 -newkey rsa:4096 -sigopt rsa_padding_mode:pss -sha256 -sigopt rsa_pss_saltlen:64 -keyout sdf-ci-key.pem -out sdf-ci-cert.pem -nodes -days 365 -subj "/CN=ns-agent-sdf-ci"
  ```
  The certificate expires 2027-10-23: make a new pair and mapping before then.
- [x] NetSuite M2M mapping (Setup → Integration → Manage Authentication → OAuth 2.0 Client Credentials (M2M) Setup): Entity = the owner, Role = Administrator, Application = SuiteCloud Development Integration, Certificate = `sdf-ci-cert.pem`. (The gateway's "NS Agent Gateway" mapping cannot deploy: its role has no SDF permission.)
- [x] Environment `production`: variables `NS_PROD_ACCOUNT_ID` = `TSTDRV1755417` and `NS_PROD_SDF_CERT_ID` = the mapping's certificate ID; secret `NS_PROD_SDF_PRIVATE_KEY` = the contents of `sdf-ci-key.pem`:
  ```bash
  gh secret set NS_PROD_SDF_PRIVATE_KEY --repo dja0086/netsuite-agent --env production < ~/.netsuite-agent/sdf-ci/sdf-ci-key.pem
  ```

Run: Actions → deploy-sdf → Run workflow (branch main), `ref` = main; `validate_only` = true first proves the credentials and the account check without changing the account.

### Rollback

An SDF deploy of an account customization project **never deletes anything** in the account. Objects and files removed from the project stay in the account; only sublist items are synced ([Oracle: deleting components deployed from a SuiteCloud project](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/subsect_1522153967.html)). Objects that are in the project replace the account's copy on every deploy. So a rollback depends on what the bad change did:

| The change… | Rollback |
| --- | --- |
| modified an object or file that existed before | Revert PR → merge → run deploy-sdf with `ref` = main (one approval). The previous definition replaces the bad one. |
| added a new object (custom field, PDF template, script) | Revert PR → merge → run deploy-sdf (keeps the account consistent with main, but the object stays). Then a NetSuite admin deletes the object in the UI (Customization → Lists, Records & Fields, or Advanced PDF/HTML Templates). A field holding data, or referenced by a search, form or script, may refuse deletion until those are cleared; deleting a field destroys its data. |
| added a SuiteScript file | Revert PR and redeploy as above; delete the file from the File Cabinet by hand if it must go. |

Record the manual deletion (what, who, when) in the revert PR. For the CP3 rehearsal, revert a change that modifies an object (for example the label of the new field): the redeploy then shows the rollback working without manual steps.

### Local deploys (before the pipeline is set up)

The SuiteCloud CLI needs a JDK (17 or 21). Run these from `netsuite/`:

```bash
suitecloud account:setup                           # browser sign-in to the demo account (one time; auth ID nsagent-demo)
suitecloud account:manageauth --info nsagent-demo  # every time: confirm the Account ID is TSTDRV1755417
suitecloud project:validate
suitecloud project:deploy
```

The first `account:setup` once linked a different (production) account, which is why the Account ID check comes before every deploy. Deployed so far: the role, the explore RESTlet and the search RESTlet. Once the checklist above is done, deploy only through `deploy-sdf.yml`.

`customrole_ns_agent` must exist first: the RESTlet deployment is restricted to it. After the role exists, import it into the repo (`docs/netsuite-role.md`) so the XML matches the account.
