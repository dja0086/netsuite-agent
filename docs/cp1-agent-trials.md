# CP1 step 8: data-explorer agent cases, tried by hand

Date 2026-10-20, account TSTDRV1755417 (demo), gateway over MCP stdio (`scripts/mcp-gateway.sh`), data-explorer 1.0.1. The agent was Claude Code following `skills/data-explorer/SKILL.md`, calling the gateway through a plain MCP client.

| Case | Tools called | Result |
| --- | --- | --- |
| `overdue-invoices-aggregate` | `ns_suiteql` x1 (no `ns_record_get`) | Pass. One aggregated query over `CustInvc` with `foreignamountunpaid > 0` and `duedate < TRUNC(SYSDATE) - 60`, elimination subsidiaries excluded, grouped by currency: 9 currencies, e.g. USD 385 invoices / 9,220,287.63. |
| `unknown-field-describes-first` | `ns_record_describe salesorder` | Pass. 377 fields, none matching rush/urgent/expedite/priority; the right answer is "no rush flag on sales orders here; which field do you mean?" rather than a guessed query. `ns_suiteql` was correctly not called. |

## Findings

- **Describe output is large.** `ns_record_describe salesorder` returns 41,799 characters (~10k tokens) for one call. Consider a `filter` argument (substring on id/label) like `ns_catalog_list` has, so the agent can search fields without loading all of them.
- **SuiteQL numbers are strings, sometimes in scientific notation.** The JPY total came back as `"3.381844953E7"`. The skill should tell the agent to format amounts before showing them.
- The tool cases (`pnpm skills:eval --mode tools`) pass 7/7; these two agent cases still need an agent-host adapter to run automatically (`scripts/eval-adapters.ts`).
