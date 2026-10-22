---
name: search-builder
description: Build, preview and save NetSuite saved searches. Use when the user wants a reusable search ("save a search", "build a saved search", "a search finance can reuse"). Previews are read-only; saving needs a named approver. Not for one-off questions (data-explorer), recurring exports (reports) or schema changes (change-control).
version: 1.0.1
owner: "@dja0086"
# Tools this skill may call. Each must exist in apps/mcp-gateway/src/tools/ (see search-builder.ts).
tools: [ns_search_preview, ns_search_save]
writes: true
enabled: true
governance_budget:
  max_calls_per_invocation: 20
  max_concurrency: 2
---

# Search Builder

Turns a description of a list ("open invoices over 60 days, with customer and amount") into a NetSuite saved search. The agent previews the search definition until it returns what the user wants, then saves it as a private saved search. Saving is a write: it needs a named approver (ADR 0004).

## When to use

- The user wants a **saved** search: something to reuse, share, or open in NetSuite later.
- The user wants to see what a saved search would return before it exists.

Hand off instead when the user only wants an answer now (data-explorer: one SuiteQL query is cheaper), wants a scheduled report or export (reports), or wants a new field or record type (change-control).

## How to work

1. **Find the real ids.** Use `ns_record_describe` (data-explorer) with `filter` for field ids you have not used in this conversation. Never guess a field id.
2. **Preview.** Call `ns_search_preview` with `recordType`, `filters` (all ANDed) and `columns`. Transactions: search type `transaction`, filter `type anyof CustInvc` (or SalesOrd, VendBill, ...) and `mainline is T` for one row per transaction. Status values look like `CustInvc:A` (open invoice).
3. **Show the preview.** Tell the user the total match count (`totalCount`) and a few rows, and adjust until they agree.
4. **Propose the save.** Pick a title and a `scriptIdSuffix` following ns-conventions (lowercase, `_`, at most 30 characters; the id becomes `customsearch_nsagent_<suffix>`).
5. **Request approval.** Call `ns_search_save` without `approvalId`. It saves nothing and returns `approval_pending` with an `approvalId` and a one-paragraph preview. Show both to the user and tell them a named approver runs `pnpm approvals approve <approvalId>`.
6. **Save.** Only after the user says it was approved, call `ns_search_save` again with exactly the same arguments plus `approvalId`. Any change to the arguments needs a new approval.

## Filters and columns

- Operators are N/search operators: `anyof`, `noneof`, `is`, `isnot`, `contains`, `startswith`, `before`, `after`, `onorbefore`, `onorafter`, `within`, `between`, `greaterthan`, `lessthan`, `isempty`, `isnotempty`, ...
- Relative dates: `{ field: duedate, operator: before, values: ["daysago60"] }`; ranges: `operator: within, values: ["thismonth"]`.
- Joined fields: `{ field: email, join: customer }` reads the customer's email from a transaction search.
- Grouped searches: give columns a `summary` (`group`, `count`, `sum`, `avg`, `min`, `max`); every column then needs one.
- Multi-currency: amount columns are in each transaction's currency. Add `currency` as a column (or group by it) rather than summing across currencies.

## Approval and safety

- `ns_search_preview` is read-only and safe to call repeatedly.
- `ns_search_save` creates a **private** saved search and nothing else. It refuses an id that already exists; it never edits or deletes searches.
- An approval covers one call with one exact payload on one account, and expires 15 minutes after it is granted.

## Do not

- Do not call `ns_search_save` with an `approvalId` the user has not confirmed was approved, or reuse one after changing arguments.
- Do not save a search the user has not previewed.
- Do not suggest creating the search by hand in NetSuite as a workaround for a denied or pending approval.
