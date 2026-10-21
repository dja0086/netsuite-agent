# data-explorer changelog

## 1.1.0 - unreleased (Phase 1)

- `ns_record_describe` takes `filter` (substring of field id or label) and reports `totalFieldCount`. Found in CP1 trials: describing `salesorder` returned 377 fields, about 10k tokens. Tool eval `describe-filter-narrows-fields` added.
- New rule: format numbers before showing them; SuiteQL returns strings and can use scientific notation (`3.381844953E7`).

## 1.0.1 - unreleased (Phase 1)

- Owner set to @dja-cowboyallstar (was a [FILL] placeholder).

## 1.0.0 - unreleased (Phase 1)

- First release: `ns_catalog_list`, `ns_record_describe`, `ns_suiteql`, `ns_record_get`, `ns_global_search`.
- Read-only. SuiteQL guarded to a single SELECT; results capped at 200 rows per call.
- Instructions cover OneWorld subsidiaries, found during Phase 0 checks (27 subsidiaries, including elimination and DNU ones).
- Currency rule: never sum `foreign*` amounts across currencies.
- SuiteQL rule: `COUNT(t.id)`, not `COUNT(*)` (fails with a table alias plus ORDER BY); regression eval added.
