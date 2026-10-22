# reports changelog

## 1.0.1 - 2026-10-22

- Owner handle moved to @dja0086 (OWNERS, frontmatter, CODEOWNERS) after the repository moved to dja0086/netsuite-agent.

## 1.0.0 - 2026-10-21

- Enabled. Acceptance: validator clean with `enabled: true`; live tool evals 8/8 on TSTDRV1755417; exports spot-checked (row counts match the account, no E notation, XLSX valid); owner approved.

## 0.1.0 - unreleased

- Scaffolded with `pnpm new:skill reports` (disabled).
- Tools: `ns_report_list`, `ns_report_run`, `ns_report_export_query` (all read-only in NetSuite; files written to `NS_AGENT_EXPORT_DIR`), backed by `packages/report-engine` (typed parameter binding, CSV and XLSX with no new dependencies, formula neutralising).
- Definitions: `ar-aging`, `open-sales-orders`, `vendor-bills-due`.
- Evals first: 8 tool cases (live 8/8 on TSTDRV1755417) and 2 agent cases; trigger prompts 6 should / 4 should not.
