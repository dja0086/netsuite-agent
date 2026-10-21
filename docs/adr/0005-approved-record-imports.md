# ADR 0005: Approved record imports (CP3)

**Status:** accepted · 2026-10-21 · builds on ADR 0004 (approvals) and the data-importer dry run

## Decision

`ns_import_run` loads a CSV that passed `ns_import_dry_run` by creating one record per row through the REST Record API (`POST /services/rest/record/v1/<type>`). It is a write tool, so it runs only through the ADR 0004 flow: first call returns `approval_pending` with a preview, a named approver approves that exact payload, the second call with `approvalId` runs it once.

## Rules

1. **Bound to the file contents.** The tool takes `fileSha256` (returned by the dry run). It is part of the approved payload, and the handler refuses to run if the file's current hash differs, so an approval for one file can never load an edited one.
2. **All rows valid, checked twice.** `describeChange` runs the dry run and refuses to request approval while any row is invalid. The handler runs the dry run again immediately before writing (records may have appeared since approval) and writes nothing if any row fails.
3. **Create only.** Rows become new records. Rows whose key already exists fail the dry run; there is no update or upsert.
4. **Small batches.** At most 500 rows per run; larger files are split. Approval window 30 minutes (`approvalTtlMinutes`).
5. **Allowed record types.** `customer` only for CP3. Each new type needs its role permission added through an SDF pull request first.
6. **Stop early on repeated failure.** Rows are created one at a time through the shared limiter. After 5 consecutive failures the run stops; rows already created stay, and the result file lists every row as `created`, `failed` or `not attempted` so a corrected file can load the rest.
7. **Evidence.** The result file (line, status, internal id, error) goes to `exports/`, and the `tool.call` audit entry carries `approvalId`, `approvedBy` and the row counts.

## Role change

The integration role gains **Lists > Customers = Create** (`LIST_CUSTJOB`), deployed by SDF from a reviewed pull request. Everything else stays View.

## Consequences

- The data-importer skill moves to 2.0.0 (it now changes what is written) and declares `writes: true`.
- Agent evals keep running with `NS_AGENT_WRITES=off`, so no eval can create records.
