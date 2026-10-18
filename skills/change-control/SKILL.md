---
name: change-control
description: How any change to the NetSuite account moves from a pull request through sandbox to production, with approvals and rollback. Read whenever a request would create or modify a field, template, script, search or record. Its tools arrive in Phase 3; until then it explains the process.
version: 0.1.0
owner: "@[FILL:tech-lead]"
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

## What to tell the user today (Phase 1)

Writes are not enabled yet. If someone asks for a change, describe what would be created (object type, script ID following ns-conventions, where it would apply) and that it will ship through this path once the relevant skill is released. Do not suggest editing NetSuite directly as a workaround.
