---
name: change-control
description: How any change to the NetSuite account moves from a pull request through sandbox to production, with approvals and rollback. Read whenever a request would create or modify a field, template, script, search or record. Its tools arrive in Phase 3; until then it explains the process.
version: 0.1.3
owner: "@dja0086"
tools: []
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
2. **Open a pull request.** CI validates the project and runs skill evals.
3. **Review.** CODEOWNERS routes `netsuite/src/Objects/` to the NetSuite admin and security.
4. **Deploy to sandbox** through the `deploy-sdf` workflow; the sandbox environment requires the NetSuite admin's approval.
5. **Verify on sandbox**, then approve the production job (NetSuite admin + security).
6. **Roll back** by merging a revert PR and running the same workflow.

## What to tell the user today

Two kinds of change exist, and they take different paths:

- **Data changes** go only through the approval-gated tools of the skills that own them: saving a saved search (search-builder, `ns_search_save`), creating customers from a CSV (data-importer, `ns_import_run`) and deleting customers (data-importer, `ns_record_delete`). Each runs only after a named approver approves the exact payload (ADRs 0004-0006). Point the user to the owning skill; there is no other write path.
- **Configuration changes** (custom fields, PDF templates, scripts, roles) take the path above. The tools that generate them and open the pull request are not released yet, so describe what would be created (object type, script ID following ns-conventions, where it would apply) and that it will ship through this path once the relevant skill is released.

Never suggest editing NetSuite directly as a workaround.
