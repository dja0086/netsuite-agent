# Example: an export with no definition (synthetic data)

**User:** Give me a spreadsheet of every vendor with their email and balance.

**Agent:** no definition covers vendors, so it calls `ns_report_export_query`:

```json
{ "q": "SELECT v.entityid AS vendor, v.email AS email, BUILTIN.DF(v.currency) AS currency, v.balance AS balance FROM vendor v WHERE v.isinactive = 'F' ORDER BY v.entityid",
  "title": "Active vendors",
  "format": "xlsx",
  "columns": [ { "key": "vendor", "label": "Vendor" }, { "key": "email", "label": "Email" },
               { "key": "currency", "label": "Currency" }, { "key": "balance", "label": "Balance", "type": "currency" } ] }
```

**Agent:** `exports/active-vendors-20261021T093000Z.xlsx`: 212 active vendors. If you will want this regularly, it can become a report definition through a pull request.
