---
name: ns-conventions
description: House rules every NetSuite skill follows - script ID prefixes, naming, SuiteQL idioms, governance budgets and data handling. Read alongside any other NetSuite skill; it has no tools of its own.
version: 1.0.0
owner: "@[FILL:tech-lead]"
tools: []
writes: false
platform: true
governance_budget:
  max_calls_per_invocation: 1
  max_concurrency: 1
---

# NetSuite conventions

## Naming and script IDs

Everything this agent creates in NetSuite carries the `nsagent` marker, so it is easy to find, review and remove.

| Object | Script ID pattern | Example |
| --- | --- | --- |
| Saved search | `customsearch_nsagent_<purpose>` | `customsearch_nsagent_ar_over_60` |
| Transaction body field | `custbody_nsagent_<name>` | `custbody_nsagent_rush` |
| Entity field | `custentity_nsagent_<name>` | `custentity_nsagent_tier` |
| Item field | `custitem_nsagent_<name>` | `custitem_nsagent_hazmat` |
| PDF template | `custtmpl_nsagent_<record>_<purpose>` | `custtmpl_nsagent_invoice_standard` |
| Saved CSV import | `custimport_nsagent_<record>` | `custimport_nsagent_customer` |
| Script / deployment | `customscript_ns_agent_<name>` / `customdeploy_ns_agent_<name>` | `customscript_ns_agent_explore_rl` |

Use lowercase, words separated by `_`, at most 30 characters after the prefix. Phase 0 checks found no existing `nsagent` objects in the account, so these prefixes are free.

## SuiteQL idioms

- Oracle dialect: `ROWNUM`, `NVL`, `||`, `TO_DATE`, `TRUNC(SYSDATE)`, `BUILTIN.DF()`. No `WITH`, `LIMIT`, `OFFSET` or `TOP`.
- Aggregate in the query; do not pull rows to count them. Count a column (`COUNT(t.id)`), never `COUNT(*)`: with a table alias and `ORDER BY` it fails.
- Join with ANSI `JOIN ... ON`, never the `(+)` operator, and never mix comma joins with ANSI joins.
- Large scans use keyset paging on `id` (the gateway does this); offset paging stops at 100,000 rows.

## Governance budgets

Each skill declares `governance_budget` in its frontmatter. Stay within it: if a task would need more calls, stop, say what you found so far, and propose a narrower question or a report/export instead. The account's concurrency is shared with every other integration, so fewer, larger queries beat many small ones.

## Data handling

- Values shown as `[REDACTED]` are masked on purpose. Do not repeat, infer or work around them.
- Do not paste large result sets into the conversation; summarise, and offer an export for anything over a few dozen rows.
- Amounts in `foreign*` fields are in transaction currency; say which currency you report in.
