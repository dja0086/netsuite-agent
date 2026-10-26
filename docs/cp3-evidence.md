# CP3 evidence: change control proven

Status: **evidence complete, waiting for the owner's sign-off** (2026-10-25). Claude does not mark checkpoints passed; the owner signs off in the Delivery plan.

## Exit criteria, as amended by the owner

The Delivery plan's CP3 criteria ("One custom field and one PDF template go PR to sandbox to production with approvals; rollback rehearsed by revert; importer writes enabled after a sandbox import reconciles row for row") were amended by two owner decisions recorded in CLAUDE.md:

- 2026-10-22: the importer criterion is met by ADR 0005's acceptance; no reconciliation file.
- 2026-10-25: there is one account (demo TSTDRV1755417) and no sandbox, so "PR to sandbox to production with approvals" means PR → the account (GitHub environment `production`) with one approval in `deploy-sdf`.

| # | Criterion | Result |
| --- | --- | --- |
| 1 | One custom field: PR → approved deploy | Met |
| 2 | One PDF template: PR → approved deploy | Met |
| 3 | Rollback rehearsed by revert | Met |
| 4 | Importer writes enabled | Met (ADR 0005) |

## The path every change took

1. The object is generated with `packages/sdf-gen` and opened as a PR on dja0086/netsuite-agent.
2. `main` is protected: it takes the PR only with the checks `checks`, `secret-scan` and `sdf-check` passing (no force push, no deletion).
3. After the merge, `deploy-sdf` is started by hand from main. It resolves `ref` to one SHA that must be on main, then waits for the required reviewer (dja0086) to approve the `production` environment. GitHub enforces both rules, so an edited workflow on a branch cannot skip them.
4. The approved job authenticates with the CI certificate (Administrator + SuiteCloud Development Integration), confirms the account is TSTDRV1755417, runs `suitecloud project:validate` on the server, then `project:deploy`, and keeps its logs as a run artifact (`sdf-production-<sha>`, 90 days).

First credential check: validate-only run [40225840388](https://github.com/dja0086/netsuite-agent/actions/runs/40225840388) on 8774b4e, 2026-10-25: success, 0 errors, nothing deployed.

## 1. Custom field

`custbody_nsagent_rush`, "Rush order": a checkbox on sales transactions, not mandatory, unchecked by default. It is a test field for CP3.

- Planned with `ns_field_plan` against the account: the script ID was absent on `transaction` and no label clashed. Then written by `ns_field_generate` (byte-identical to sdf-gen's golden file).
- PR [#9](https://github.com/dja0086/netsuite-agent/pull/9), merged as e55a1c2.
- Deploy run [40226917223](https://github.com/dja0086/netsuite-agent/actions/runs/40226917223), approved by the owner: validation and deploy SUCCESS, 0 errors.
- Check afterwards (read-only): `salesorder` metadata lists `custbody_nsagent_rush` "Rush order" (boolean, custom), and its field count went from 377 to 378. SuiteQL on `transaction` resolves the column.

## 2. PDF template

`custtmpl_nsagent_invoice_standard`, "NS Agent - Invoice": an Advanced PDF/HTML template for invoices (standard `STDTMPLCUSTINVC`), **not preferred**, so no printout changed.

- Generated with sdf-gen: the template lint found no issues. The template loads only NetSuite-hosted resources (`${nsfont.*}`, `${companyInformation.logoUrl}`).
- Previewed before the PR against invoice 46374 through the deployed PDF RESTlet (renders, checks resources, then makes the PDF). It produced a 1-page PDF with the invoice number, dates, three lines and the total.
- `suitecloud project:validate` against the account: 0 errors.
- PR [#16](https://github.com/dja0086/netsuite-agent/pull/16), merged as 26cb58d.
- Deploy run [40229632648](https://github.com/dja0086/netsuite-agent/actions/runs/40229632648), approved by the owner: validation and deploy SUCCESS, 0 errors, `CUSTOM_OBJECT_CREATION --- custtmpl_nsagent_invoice_standard`.
- Check afterwards: `suitecloud object:list --type advancedpdftemplate` (auth `nsagent-demo`, account ID confirmed) lists `custtmpl_nsagent_invoice_standard`.

## 3. Rollback rehearsal

The rehearsal changes an existing object, then reverts it. SDF deploys replace existing objects but never delete them, so this rollback needs no manual step (`docs/release.md`, "Rollback").

| Step | PR | Merge | Deploy run | `custbody_nsagent_rush` label afterwards (fresh metadata, salesorder and invoice) |
| --- | --- | --- | --- | --- |
| Starting point | #9 | e55a1c2 | [40226917223](https://github.com/dja0086/netsuite-agent/actions/runs/40226917223) | "Rush order" |
| Change | [#14](https://github.com/dja0086/netsuite-agent/pull/14) | d5ae560 | [40227842183](https://github.com/dja0086/netsuite-agent/actions/runs/40227842183) | "Rush order (same day)" |
| Revert | [#15](https://github.com/dja0086/netsuite-agent/pull/15) | 5e999ec | [40228572479](https://github.com/dja0086/netsuite-agent/actions/runs/40228572479) | "Rush order" |

Each deploy was approved by the owner and reported 0 errors.

Note for whoever checks labels later: the gateway caches record metadata for an hour, so read fresh metadata (`describeRecordSchema`) right after a deploy.

## 4. Importer writes

Met by ADR 0005 (approved customer imports through the REST Record API), as the owner decided on 2026-10-22. Live evidence is in CLAUDE.md: customers `nsagent-cp3-test-001/002` were created and deleted through the approved paths.

## What CP3 rests on (merged PRs)

| PR | What |
| --- | --- |
| [#3](https://github.com/dja0086/netsuite-agent/pull/3), [#6](https://github.com/dja0086/netsuite-agent/pull/6) | `packages/sdf-gen`; the custom-fields skill (disabled), after three rounds of the SuiteCloud acceptance loop |
| [#2](https://github.com/dja0086/netsuite-agent/pull/2), [#7](https://github.com/dja0086/netsuite-agent/pull/7) | PDF preview RESTlet; renders, checks resources, then makes the PDF (deployed 2026-10-23) |
| [#4](https://github.com/dja0086/netsuite-agent/pull/4), [#8](https://github.com/dja0086/netsuite-agent/pull/8), [#12](https://github.com/dja0086/netsuite-agent/pull/12), [#13](https://github.com/dja0086/netsuite-agent/pull/13) | `deploy-sdf`; approvals through GitHub environment protection (repo public); eval job off the environments; one stage, one approval |
| #9, #14, #15, #16 | The field, the rollback rehearsal and the template above |

## Known limits (not CP3 criteria)

- The repo is public. Before making it private again, upgrade to a plan with environment protection for private repos, or delete the deploy secret first (`docs/release.md`).
- The CI certificate expires 2027-10-23.
- The test field `custbody_nsagent_rush` and the template stay in the account. Removing them is a manual step in the NetSuite UI.
