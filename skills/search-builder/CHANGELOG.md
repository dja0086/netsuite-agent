# search-builder changelog

## 0.1.0 - unreleased

- Scaffolded with `pnpm new:skill search-builder` (disabled).
- Tools: `ns_search_preview` (read-only) and `ns_search_save` (write, approval-gated through ADR 0004), backed by the `customscript_ns_agent_search_rl` RESTlet.
- Evals first: 6 tool cases (preview, grouped preview, unknown operator, unsafe field, save blocked without approval, bad script id) and 2 agent cases; trigger prompts 6 should / 5 should not.
