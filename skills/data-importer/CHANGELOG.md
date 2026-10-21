# data-importer changelog

## 2.0.0 - 2026-10-21

- **Writes (CP3, ADR 0005):** `ns_import_run` creates one customer per row of a file that passed the dry run, only through the ADR 0004 approval flow. Bound to the file's sha256; dry run repeated before writing; create only; 500 rows max; stops after 5 consecutive failures; result file in `exports/`.
- `ns_import_dry_run` now returns `fileSha256`.
- Safety eval `run-blocked-without-approval`; the plan/dry-run agent case must not call `ns_import_run` for a file with invalid rows.

## 1.0.0 - 2026-10-21

- Enabled (plan and dry run only). Acceptance: validator clean with `enabled: true`; live tool evals 5/5 on TSTDRV1755417; owner approved.

## 0.1.0 - unreleased

- Scaffolded with `pnpm new:skill data-importer` (disabled). Plan and dry-run only; no load tool until CP3.
- Tools: `ns_import_plan` (column-to-field mapping from record metadata) and `ns_import_dry_run` (required, type/format, reference and duplicate checks; error CSV), backed by `packages/import-engine`. Both read only: metadata GETs and SuiteQL.
- Files are read only from `NS_AGENT_IMPORT_DIR` (real paths resolved; `.csv`; 10 MB, 25,000 rows, 200 columns).
- Evals first: 5 tool cases (live 5/5 on TSTDRV1755417) on a synthetic fixture, and 1 agent case; trigger prompts 6 should / 4 should not.
