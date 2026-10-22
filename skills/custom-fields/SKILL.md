---
name: custom-fields
description: Design a NetSuite custom field (transaction body, customer/vendor/contact, or item field), check the account for clashes and write its SDF XML into the SuiteCloud project for a pull request. Use for "add a field", "we need a checkbox/date/list field on ...", "draft the field definition". Never creates fields live; the field reaches NetSuite only through a PR and the approved deploy. Not for reading field values (data-explorer) or PDF layouts (pdf-templates).
version: 0.1.0
owner: "@dja0086"
# Tools this skill may call. Each must exist in apps/mcp-gateway/src/tools/ (see custom-fields.ts).
tools: [ns_field_plan, ns_field_generate]
writes: false
# New skills ship disabled. Set to true only when the acceptance table passes (see docs/skill-lifecycle.md).
enabled: false
governance_budget:
  max_calls_per_invocation: 10
  max_concurrency: 2
---

# Custom fields

Turns a request for a new field into an SDF object in `netsuite/src/Objects/fields/`. `ns_field_plan` validates the spec, builds the XML and checks the account's record metadata for a field with the same script ID or label; it changes nothing. `ns_field_generate` writes the file (and any manifest features it needs) into the SuiteCloud project on the gateway host. Neither tool talks to NetSuite to create anything: the field ships through a pull request and the approved `deploy-sdf` workflow (ADR 0002, change-control skill).

## When to use

- A user wants a new field on transactions (sales orders, invoices, purchase orders, journals, ...), on customers, vendors or contacts, or on items.
- A user wants to change a field this project already owns (its file is in `Objects/fields/`).

Hand off instead when: the user asks what an existing field means or which records have a value (data-explorer), wants a printed form changed (pdf-templates), or asks how a change gets approved or rolled back (change-control).

## How to work

1. **Shape the spec.** Pick:
   - `kind`: `body` (transactions), `entity` (customer, vendor, employee, contact, partner, project) or `item`.
   - `name`: lowercase snake_case, at most 21 characters. It becomes `custbody_nsagent_<name>`, `custentity_nsagent_<name>` or `custitem_nsagent_<name>` (ns-conventions). Keep the user's full wording as the `label`.
   - `type`: CHECKBOX, CURRENCY, DATE, DATETIMETZ, EMAIL, FLOAT, INTEGER, MULTISELECT, PERCENT, PHONE, SELECT, TEXT, TEXTAREA or URL. SELECT and MULTISELECT need `selectRecordType`, a standard record type id such as `-2` (customer) or `-4` (employee). Custom lists are not supported yet.
   - `appliesTo`: where the field shows, for example `sale` for sales transactions. Only list what the user asked for.
2. **Plan.** Call `ns_field_plan`. Show the script ID, the record types it checked, `uncheckedRecordTypes` (say the deploy's server validation is the final check for those), any `collisions` and `warnings`, and the manifest `features`. Show the XML only if the user asks.
3. **Resolve clashes.** If `ready` is false, propose another name, or ask whether the user means the existing field. A label clash is a warning: point it out and let the user decide.
4. **Agree, then generate.** Ask the user to confirm the spec. Only then call `ns_field_generate` with exactly the agreed arguments. Report `written` and `manifestFeaturesAdded`.
5. **Hand over to change control.** The files are on disk, not in NetSuite. Say the next step is a branch and pull request, then the approved deploy (sandbox stage, then production stage). Do not claim the field exists in NetSuite.

To change a field this project owns, plan it with the new values, then generate with `replace: true`. Removing a field is not done by deleting the file: SDF deploys never delete objects, so a NetSuite admin removes it in the UI after the revert is merged (change-control).

## Approval and safety

These tools never write to NetSuite, so they need no approval from the gateway. The gate is later and stricter: the pull request review, then a named approver for each deploy stage. `ns_field_generate` writes only inside the SDF project folder (`NS_AGENT_SDF_DIR`, default `netsuite/src`) and refuses:

- a script ID that already exists in NetSuite but is not in the project, because deploying it would take over someone else's field;
- overwriting a field file unless `replace` is true.

## Do not

- Do not create or edit fields in NetSuite directly, or suggest doing it in the UI as a workaround.
- Do not mark a field mandatory on existing transaction types without saying that every user saving those records will then have to fill it.
- Do not invent `selectRecordType` ids; ask, or use data-explorer to find the record type.
- Do not generate before the user has agreed the spec, and do not pass `replace: true` unless the user asked to change that field.
