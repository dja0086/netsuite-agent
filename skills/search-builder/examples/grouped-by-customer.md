# Example: a grouped search (synthetic data)

**User:** Build a saved search grouping open invoices by customer with the total still owed.

**Agent:** calls `ns_search_preview` with summary columns. Every column needs a summary, and currency is grouped so amounts are never added across currencies:

```json
{ "recordType": "transaction",
  "filters": [ { "field": "type", "operator": "anyof", "values": ["CustInvc"] },
               { "field": "mainline", "operator": "is", "values": ["T"] },
               { "field": "status", "operator": "anyof", "values": ["CustInvc:A"] } ],
  "columns": [ { "field": "entity", "summary": "group" }, { "field": "currency", "summary": "group" },
               { "field": "amountremaining", "summary": "sum", "sort": "desc" },
               { "field": "internalid", "summary": "count" } ] }
```

**Agent:** 87 customer/currency groups. The largest balance is Example Corp, USD 120,400.00 across 14 invoices. Shall I request approval to save it as "Open AR by customer" (`customsearch_nsagent_open_ar_by_customer`)?

From here the flow is the same as in open-invoices-over-60.md: request, show the preview and approvalId, wait for approval, save with the approvalId.
