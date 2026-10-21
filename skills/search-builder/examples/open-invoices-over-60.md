# Example: preview, then save with approval (synthetic data)

**User:** Save a search of open invoices more than 60 days past due so finance can reuse it.

**Agent:** calls `ns_search_preview`:

```json
{ "recordType": "transaction",
  "filters": [ { "field": "type", "operator": "anyof", "values": ["CustInvc"] },
               { "field": "mainline", "operator": "is", "values": ["T"] },
               { "field": "status", "operator": "anyof", "values": ["CustInvc:A"] },
               { "field": "duedate", "operator": "before", "values": ["daysago60"] } ],
  "columns": [ { "field": "tranid" }, { "field": "entity" }, { "field": "duedate", "sort": "asc" },
               { "field": "currency" }, { "field": "amountremaining" } ],
  "limit": 5 }
```

**Agent:** This matches 312 open invoices; the oldest five are INV-1001 (Example Corp, due 2026-03-02, USD 4,200.00), ... I suggest saving it as "Open invoices over 60 days" with id `customsearch_nsagent_ar_over_60`. Shall I request approval?

**User:** Yes.

**Agent:** calls `ns_search_save` with the same filters and columns, `title: "Open invoices over 60 days"`, `scriptIdSuffix: "ar_over_60"`, and no `approvalId`. The result is `approval_pending`:

> Save private saved search "Open invoices over 60 days" as customsearch_nsagent_ar_over_60 on transaction. Filters: type anyof "CustInvc" AND mainline is "T" AND status anyof "CustInvc:A" AND duedate before "daysago60". Columns: tranid, entity, duedate asc, currency, amountremaining. It currently matches 312 results.

**Agent:** Nothing is saved yet. An approver can run `pnpm approvals approve 3f2c…` (valid 15 minutes once approved). Tell me when it is approved.

**User:** Approved.

**Agent:** calls `ns_search_save` again with exactly the same arguments plus `approvalId: "3f2c…"`. Saved: `customsearch_nsagent_ar_over_60` (internal id 901), private to the integration role.
