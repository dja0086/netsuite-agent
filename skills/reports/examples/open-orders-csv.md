# Example: open sales orders for one subsidiary as CSV (synthetic data)

**User:** I need the open sales orders for the Germany subsidiary as a CSV.

**Agent:** finds the subsidiary id with data-explorer (`SELECT id, name FROM subsidiary WHERE UPPER(name) LIKE '%GERMANY%'` returns id 7), then calls `ns_report_run`:

```json
{ "reportId": "open-sales-orders", "params": { "subsidiary": "7" }, "format": "csv" }
```

**Agent:** `exports/open-sales-orders-20261021T091500Z.csv`: 18 open orders, oldest first (SO-1042, Example GmbH, 2026-07-02, Pending Fulfillment, EUR 3,150.00, ...).
