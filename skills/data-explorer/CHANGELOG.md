# data-explorer changelog

## 1.0.0 - unreleased (Phase 1)

- First release: `ns_catalog_list`, `ns_record_describe`, `ns_suiteql`, `ns_record_get`, `ns_global_search`.
- Read-only. SuiteQL guarded to a single SELECT; results capped at 200 rows per call.
- Instructions cover OneWorld subsidiaries, found during Phase 0 checks (27 subsidiaries, including elimination and DNU ones).
- Currency rule: never sum `foreign*` amounts across currencies.
- SuiteQL rule: `COUNT(t.id)`, not `COUNT(*)` (fails with a table alias plus ORDER BY); regression eval added.
