---
name: change-control
description: How any change to the NetSuite account moves from a pull request through sandbox to production, with approvals and rollback. Read whenever a request would create or modify a field, template, script, search or record. Opens the pull request for generated SDF objects (ns_change_open_pr, not released yet); until then it explains the process.
version: 0.2.0
owner: "@dja0086"
tools: [ns_change_open_pr]
# Platform skills are always served, so a new tool ships disabled here until the owner accepts it (docs/skill-lifecycle.md).
disabled_tools: [ns_change_open_pr]
writes: false
platform: true
governance_budget:
  max_calls_per_invocation: 1
  max_concurrency: 1
---

# Change control

No skill edits NetSuite configuration live. Account changes travel as SuiteCloud (SDF) objects in this repository.

## The path every change takes

1. **Generate** the SDF object (field XML, template, script) with the owning skill's tool.
2. **Open a pull request.** `ns_change_open_pr` commits only the generated objects' files (and `manifest.xml`) onto a new `nsagent/` branch from `origin/main`, pushes it to `dja0086/netsuite-agent` and opens the PR with the local gh login; the PR body carries the reviewer checklist below. It publishes to GitHub, so call it only after the user agreed, with the script IDs that were generated. It refuses when origin is not `dja0086/netsuite-agent`, when gh's active account is not `dja0086`, or when the working tree has other changes; tell the user which one and how to fix it, never work around it. CI validates the project and runs skill evals.
3. **Review.** CODEOWNERS routes `netsuite/src/Objects/` to the NetSuite admin and security. For a PDF template (`*.template.xml`), review is the security control, not a formality: SDF does not validate template contents, and sdf-gen's `templateSourceIssues` is a lint that FreeMarker can get round. The reviewer reads every `src`, `href`, `url(...)` and `<link>`, and any FreeMarker that builds an address or redefines a variable, and accepts only NetSuite-hosted resources (fonts via `${nsfont.*}`, the company logo, `/core/media/` files), never addresses built from record data.
4. **Deploy to sandbox** through the `deploy-sdf` workflow; the sandbox environment requires the NetSuite admin's approval.
5. **Verify on sandbox**, then approve the production job (NetSuite admin + security).
6. **Roll back** by merging a revert PR and running the same workflow.

## What to tell the user today

Two kinds of change exist, and they take different paths:

- **Data changes** go only through the approval-gated tools of the skills that own them: saving a saved search (search-builder, `ns_search_save`), creating customers from a CSV (data-importer, `ns_import_run`) and deleting customers (data-importer, `ns_record_delete`). Each runs only after a named approver approves the exact payload (ADRs 0004-0006). Point the user to the owning skill; there is no other write path.
- **Configuration changes** (custom fields, PDF templates, scripts, roles) take the path above. The tools that generate them (custom-fields, pdf-templates) and open the pull request (`ns_change_open_pr`) are built but not released yet. When they are not offered, describe what would be created (object type, script ID following ns-conventions, where it would apply) and that it will ship through this path once the relevant skill is released.

Never suggest editing NetSuite directly as a workaround.
