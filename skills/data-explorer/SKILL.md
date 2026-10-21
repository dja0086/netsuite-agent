---
name: data-explorer
description: Answer questions about NetSuite data read-only - find record types, describe fields, look up a record, run SuiteQL, or keyword-search the account. Use for "how many", "which", "show me", "find" and "what does field X mean" questions. Not for building saved searches, reports, imports or any change to data.
version: 1.1.0
owner: "@dja-cowboyallstar"
tools: [ns_catalog_list, ns_record_describe, ns_suiteql, ns_record_get, ns_global_search]
writes: false
governance_budget:
  max_calls_per_invocation: 25
  max_concurrency: 2
---

# Data explorer

Read-only access to NetSuite data through the gateway. Every tool here is safe to call; none of them change anything.

## When to use

- Counting, listing, filtering or summarising records ("how many open invoices over 60 days?").
- Looking up one record by name, number or id.
- Finding what a field or record type is called before writing a query.

Hand off instead when the user wants to **save** a search (search-builder), produce a **recurring report or export** (reports), **load a file** (data-importer), or **change** a field, template or record (change-control).

## How to answer

1. **Know the shape first.** If you are not sure of a record type id, call `ns_catalog_list` with a filter. Before querying fields you have not used in this conversation, call `ns_record_describe`; pass `filter` (part of a field id or label, e.g. `rush` or `date`) when you are looking for specific fields, because large records such as `salesorder` have hundreds. Never guess field ids.
2. **Prefer one aggregated query.** Use `ns_suiteql` with `COUNT`, `SUM` and `GROUP BY` rather than fetching rows and counting them yourself. Ask for the columns you need, not `*`.
3. **Look up single records** with `ns_record_get`, passing `fields` to keep the response small. Use `ns_global_search` when the user gives a name or number but not an id.
4. **Page deliberately.** `ns_suiteql` returns at most 200 rows. If `hasMore` is true, say how many rows exist (`totalResults`) and offer to narrow the question rather than paging through everything.
5. **Show your working.** State the query or record you used in one line so the user can check it.
6. **Format numbers before showing them.** SuiteQL returns every value as a string, and large amounts can come back in scientific notation (`3.381844953E7`). Present them as ordinary numbers with the currency (`JPY 33,818,449.53`), never in E notation.

## SuiteQL rules (Oracle dialect)

- Row limits: `WHERE ROWNUM <= 10`. There is no `LIMIT`, `TOP`, `OFFSET` or `WITH`.
- Dates: `TO_DATE('2026-10-01', 'YYYY-MM-DD')`, `TRUNC(SYSDATE)`, `ADD_MONTHS(...)`.
- Display values for list fields: `BUILTIN.DF(t.entity)`.
- Counting: use `COUNT(t.id)`, not `COUNT(*)`. `COUNT(*)` combined with a table alias and `ORDER BY` fails with "Invalid or unsupported search".
- Text: `||` to concatenate, `NVL(x, 'default')` for nulls, `UPPER(...) LIKE UPPER('%acme%')` for case-insensitive search.
- Transactions share one table. Filter with `t.type`, using internal codes: `CustInvc` (invoice), `SalesOrd`, `CustPymt`, `VendBill`, `PurchOrd`, `Journal`, `CustCred`, `Estimate`, `Opprtnty`.
- Header vs lines: `transaction` holds headers; `transactionline` holds lines (`tl.transaction = t.id`). Use `tl.mainline = 'T'` for the header row when joining.

## Multi-subsidiary accounts

This account is OneWorld with many subsidiaries, including elimination subsidiaries (names starting `xElimination`) and inactive ones (marked `DNU`). When a question is about money, ask which subsidiary or say which one you used, and exclude elimination subsidiaries unless the user asks for consolidated figures.

- `BUILTIN.DF(t.subsidiary)` returns the full hierarchy path, e.g. `HEADQUARTERS : EMEA : Germany`; show the last segment unless the hierarchy matters.
- `foreignamount*` fields are in each transaction's own currency. Never sum them across subsidiaries with different currencies as if they were one figure: group by currency (`BUILTIN.DF(t.currency)`) or say the totals are not comparable. Yen balances, for example, dwarf every other subsidiary when summed raw.

## Do not

- Do not write or suggest DML; the gateway rejects anything but a single `SELECT`.
- Do not return more rows than the user needs; summarise instead.
- Do not repeat values the gateway shows as `[REDACTED]`, and do not try to work around redaction.
