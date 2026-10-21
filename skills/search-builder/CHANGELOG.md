# search-builder changelog

## 1.0.0 - 2026-10-21

- Enabled. Acceptance: validator clean with `enabled: true`; live tool evals 6/6 on TSTDRV1755417 (safety case included); owner approved.
- First live approved save: `customsearch_nsagent_ar_over_60` (internal id 2822) through the ADR 0004 flow; replaying the approvalId was refused.

## 0.1.0 - unreleased

- Scaffolded with `pnpm new:skill search-builder` (disabled).
- Tools: `ns_search_preview` (read-only) and `ns_search_save` (write, approval-gated through ADR 0004), backed by the `customscript_ns_agent_search_rl` RESTlet.
- Evals first: 6 tool cases (preview, grouped preview, unknown operator, unsafe field, save blocked without approval, bad script id) and 2 agent cases; trigger prompts 6 should / 5 should not.
