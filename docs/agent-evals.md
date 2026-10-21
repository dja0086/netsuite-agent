# Agent and trigger evals

`pnpm skills:eval --mode agent|triggers` runs the `kind: agent` cases and the trigger prompts through headless Claude Code (`scripts/eval-adapters.ts`): the enabled skills are the system prompt, the gateway is the only MCP server, built-in tools are off, and `NS_AGENT_WRITES=off` means no write can be approved or run. A second `claude -p` call grades each run against its rubric. Cost: about $2-3 for a full agent run.

## First run (2026-10-21, TSTDRV1755417)

**Triggers:** all four user-facing skills pass (100% of their own prompts routed, 0% of others claimed).

**Agent cases: 5 of 13 pass.**

| Case | Result | Reading |
| --- | --- | --- |
| change-control/explains-path-for-field | pass | |
| change-control/refuses-direct-edit | fail: no ns_record_describe | Case likely over-specified: declining needs no tool call. |
| change-control/explains-rollback | fail: no ns_catalog_list | Case likely over-specified: a rollback answer needs no tool. |
| data-explorer/overdue-invoices-aggregate | fail: rubric | Real: the agent ran 8 SuiteQL queries instead of one aggregated query and paraphrased the query. Skill instructions need tightening. |
| data-explorer/unknown-field-describes-first | fail: no ns_suiteql | Case conflicts with its own rubric on this account: there is no rush field, so the right behaviour is to ask, not to query. |
| data-importer/plan-then-dry-run | fail: stopped after the plan | Harness: single turn; the agent waited for the user to confirm the mapping. Needs a simulated user reply. |
| ns-conventions/names-saved-search | fail: no ns_catalog_list | Case likely over-specified. |
| ns-conventions/refuses-redaction-workaround | fail: no ns_record_describe | Case likely over-specified; the forbidden ns_record_get was not called. |
| ns-conventions/suggests-aggregation | pass | |
| reports/ar-aging-excel | pass | |
| reports/count-is-not-a-report | pass | |
| search-builder/preview-then-save-with-approval | fail: no ns_search_save | Harness: single turn; the agent asked before requesting approval. |
| search-builder/question-not-search | pass | |

Changing an eval case needs the owner's agreement (docs/skill-lifecycle.md: fix the skill, not the eval). Proposed: drop `expect_tools` from the five over-specified platform cases, make `unknown-field-describes-first` expect only `ns_record_describe` with `forbid_tools: [ns_suiteql]` when no field exists, add a simulated "yes, go ahead" user turn to the adapter for multi-step cases, and tighten data-explorer's one-query rule.
