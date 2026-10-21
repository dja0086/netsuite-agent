# ADR 0006: Approved record deletes

**Status:** accepted · 2026-10-21 · owner request ("add a delete path upon approval"); builds on ADR 0004 and ADR 0005

## Decision

`ns_record_delete` permanently deletes records by internal id, only through the ADR 0004 approval flow. It is paired with a read-only `ns_record_delete_preview` that shows each record (name, external id, last modified) and returns a `snapshot`: a sha256 of the ids and their last-modified times.

## Rules

1. **Bound to what the approver saw.** `snapshot` is part of the approved payload. `describeChange` and the handler both re-read the records and refuse if any is missing or its last-modified time changed, so a record edited after approval is never deleted.
2. **Internal ids only**, at most 25 per call, no duplicates. External ids are refused so the approved list is exactly what is deleted.
3. **Allowed record types:** `customer` only. Each new type needs its role permission and a pull request.
4. **No cascade, no search-and-delete.** One DELETE per listed id; NetSuite's own rules still apply (for example a customer with transactions cannot be deleted, and is reported as failed).
5. Stops after 5 consecutive failures; returns deleted, failed and not-attempted ids. Approval window 15 minutes.

## Role change

NetSuite grants delete only at **Full**, so `customrole_ns_agent` goes from Lists > Customers = Create to **Full**. Full also allows editing customers; the gateway exposes no edit tool, so the only customer writes the agent can make are approved creates (`ns_import_run`) and approved deletes. Revisit if an edit tool is ever proposed.

## Consequences

- data-importer 3.0.0 declares both tools (deleting is how an import is undone).
- Agent evals run with `NS_AGENT_WRITES=request-only`; no eval can delete.
