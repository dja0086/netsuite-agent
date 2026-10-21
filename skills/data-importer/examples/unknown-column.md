# Example: a column the plan cannot match (synthetic data)

**User:** Check vendors.csv; it has a "Tax Reg" column.

**Agent:** calls `ns_import_plan` (`recordType: vendor`). "Tax Reg" is unmapped. calls `ns_record_describe` with `type: vendor, filter: tax` and finds `vatRegNumber` (label "Tax Number").

**Agent:** "Tax Reg" looks like `vatRegNumber` (Tax Number). Shall I map it there?

**User:** Yes.

**Agent:** calls `ns_import_dry_run` with `"Tax Reg": "vatRegNumber"` in the mapping. Tax numbers are redacted in the results, so the agent reports only that 2 rows have an invalid tax number, with their line numbers.
