---
name: reports
description: Produce NetSuite reports as CSV or Excel files - AR aging, open sales orders, vendor bills due, or any SELECT exported to a file. Use when the user wants a file, a spreadsheet or "the report". Read-only. Not for a quick number or short list in chat (data-explorer) or a reusable NetSuite saved search (search-builder).
version: 1.0.0
owner: "@dja-cowboyallstar"
# Tools this skill may call. Each must exist in apps/mcp-gateway/src/tools/ (see reports.ts).
tools: [ns_report_list, ns_report_run, ns_report_export_query]
writes: false
enabled: true
governance_budget:
  max_calls_per_invocation: 20
  max_concurrency: 2
---

# Reports

Runs reviewed report definitions (parameterised SuiteQL in `skills/reports/definitions/`) and one-off SELECT exports, and writes every row to a CSV or XLSX file on the gateway host. Nothing in NetSuite changes.

## When to use

- The user wants a **file**: "as Excel", "a CSV", "a spreadsheet", "the report", "download".
- The result is too long to read in chat (more than about 20 rows).

Hand off instead when the user wants one number or a short list (data-explorer), a saved search that lives in NetSuite (search-builder), or a scheduled or emailed report (not available yet: say so).

## How to work

1. **Pick a definition.** Call `ns_report_list` and match the request to a report id. Prefer a definition over an ad-hoc query: definitions are reviewed and handle currencies, eliminations and date formats.
2. **Set parameters.** Dates are `YYYY-MM-DD` (work out "end of last month" yourself); `subsidiary` is an internal id (find it with data-explorer if the user names one). Leave optional parameters out rather than guessing.
3. **Run it.** Call `ns_report_run` with `format: xlsx` unless the user asks for CSV.
4. **Hand over the file.** Give the `file` path, `rowCount`, and two or three lines from `sample` so the user can check it is right. If `truncated` is true, say so and suggest a narrower parameter. Do not paste the whole report into chat.
5. **No definition fits?** Use `ns_report_export_query` with one SELECT (SuiteQL rules from data-explorer apply). Pass `columns` with types (`currency`, `date`, `integer`) so numbers and dates are typed in Excel, and `TO_CHAR(date, 'YYYY-MM-DD')` for date columns. If the user will want it again, suggest adding a definition by pull request.

## Currencies and subsidiaries

- Amount columns are in each transaction's own currency. Definitions group or label by currency; never add totals across currencies when describing the file.
- AR aging excludes elimination subsidiaries.

## Files

- Files are written to `NS_AGENT_EXPORT_DIR` (default `./exports`, not committed). Redacted fields (`NS_AGENT_REDACT_FIELDS`) are masked inside the file too.
- Text that a spreadsheet would treat as a formula is prefixed with `'`.

## Do not

- Do not page through `ns_suiteql` results to build a file by hand; use these tools.
- Do not promise to email or schedule reports.
