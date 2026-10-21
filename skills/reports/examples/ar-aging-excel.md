# Example: AR aging as Excel (synthetic data)

**User:** Send me the AR aging as of the end of last month as Excel.

**Agent:** calls `ns_report_list`, picks `ar-aging`, works out that the end of last month is 2026-09-30, and calls:

```json
{ "reportId": "ar-aging", "params": { "as_of": "2026-09-30" }, "format": "xlsx" }
```

**Agent:** Here is the AR aging as of 2026-09-30: `exports/ar-aging-20261001T080000Z.xlsx` (146 rows, one per customer and currency). For example, Example Corp has USD 12,400.00 over 90 days. Amounts are in each currency, so the file has no grand total across currencies. Elimination subsidiaries are excluded.
