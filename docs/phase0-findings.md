# Phase 0 findings

Checked on 2026-10-18 through the NetSuite AI Connector (MCP Standard Tools) connected to the build session. All checks were read-only SuiteQL and metadata calls, run under the connector's role, not the future integration role.

## Account shape

- **OneWorld with 27 subsidiaries**, including four elimination subsidiaries (`xElimination ...`), one marked `DNU` (APAC - DNU), and four consolidated views (HEADQUARTERS, AMERICAS, APAC, EMEA). Display names come back as hierarchy paths, e.g. `HEADQUARTERS : EMEA : Germany`.
- **Multiple currencies.** Open invoice balances summed raw by subsidiary are dominated by the Japan subsidiary (yen). Any money question needs a currency rule; this is now in the data-explorer skill.

## Volumes

| Record | Count |
| --- | --- |
| Transactions | 4,052 |
| Customers | 1,014 |
| Items | 881 |
| Employees | 187 |
| Vendors | 141 |

Largest transaction types: invoices (`CustInvc`) 1,104; journals 546; customer payments 512; sales orders 389; opportunities 208; vendor bills 264; revenue arrangements 187.

Every table is far below the 100,000-row SuiteQL cap, so a full scan of any table is at most 5 keyset pages of 1,000.

## Existing customizations

- 232 transaction body custom fields (`custbody*`) already exist. New fields must use the `custbody_nsagent_` prefix to stay distinguishable.
- No scripts and no saved searches with an `nsagent` / `ns_agent` id exist, so the naming in `ns-conventions` is free.

## SuiteQL observations

- Verified working: grouped aggregates over `transaction`, `BUILTIN.DF()`, `foreignamountunpaid`, `transactionline` joined on `tl.transaction = t.id` with `mainline`.
- **`COUNT(*)` breaks with a table alias plus `ORDER BY`.** `SELECT t.type, COUNT(*) AS n FROM transaction t GROUP BY t.type ORDER BY n DESC` fails with "Invalid or unsupported search". Each pair of the three parts works on its own, and `COUNT(t.id)` works in the full combination. Rule added to data-explorer and ns-conventions: count a column (`COUNT(t.id)`), not `*`.

## Still open for CP0

- Is the connected account the **sandbox** or production? Phase 1 evals and the gateway must point at a sandbox. Answered 2026-10-20: TSTDRV1755417 is a test-drive/demo account (environment type PRODUCTION, no live business data), so it runs as `NS_TARGET_KIND=demo`.
- Service tier and SuiteCloud Plus licence count (sets `NS_MAX_CONCURRENCY`). Not visible through SuiteQL; read it from Setup > Integration > Integration Management > Integration Governance. Answered 2026-10-20: account concurrency limit 5; 2 allocated to the NS Agent Gateway integration record, so `NS_MAX_CONCURRENCY=2`.
- Integration record, certificate and `customrole_ns_agent` role (see `docs/netsuite-role.md`).
