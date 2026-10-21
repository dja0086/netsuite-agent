# data-importer changelog

## 0.1.0 - unreleased

- Scaffolded with `pnpm new:skill data-importer` (disabled). Plan and dry-run only; no load tool until CP3.
- Tools: `ns_import_plan` (column-to-field mapping from record metadata) and `ns_import_dry_run` (required, type/format, reference and duplicate checks; error CSV), backed by `packages/import-engine`. Both read only: metadata GETs and SuiteQL.
- Files are read only from `NS_AGENT_IMPORT_DIR` (real paths resolved; `.csv`; 10 MB, 25,000 rows, 200 columns).
- Evals first: 5 tool cases (live 5/5 on TSTDRV1755417) on a synthetic fixture, and 1 agent case; trigger prompts 6 should / 4 should not.
