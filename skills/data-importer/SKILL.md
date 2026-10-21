---
name: data-importer
description: Import a CSV into NetSuite - map the columns to record fields, dry-run every row (required fields, types, references, duplicates), then create the records after a named approver approves. Use for "import this CSV", "is this file ready to load", "load these customers". Create only, customers only for now. Not for exports (reports) or questions about existing data (data-explorer).
version: 2.0.0
owner: "@dja-cowboyallstar"
# Tools this skill may call. Each must exist in apps/mcp-gateway/src/tools/ (see data-importer.ts).
tools: [ns_import_plan, ns_import_dry_run, ns_import_run]
writes: true
enabled: true
governance_budget:
  max_calls_per_invocation: 20
  max_concurrency: 2
---

# Data importer

Gets a CSV into NetSuite: proposes which record field each column fills, checks every row against the account (required fields, types and formats, references such as subsidiary and currency, and duplicates), and, once every row is valid and a named approver approves, creates one record per row. Planning and the dry run change nothing; only `ns_import_run` writes, and only through approval (ADR 0005).

## When to use

- The user has a CSV of records (customers, vendors, contacts, ...) to bring into NetSuite.
- The user wants to know whether a file is ready, or what is wrong with it.

Hand off instead when the user wants data out of NetSuite (reports), a question answered (data-explorer), or a new field to hold a column (change-control).

## How to work

1. **Locate the file.** It must be in the import folder (`NS_AGENT_IMPORT_DIR`, default `./imports` on the gateway host). Pass the file name, not a path. If it is not there, ask the user to copy it in.
2. **Plan.** Call `ns_import_plan` with the file and record type. Show the proposed mapping as a short table (column -> field), the unmapped columns, and `missingRequired`.
3. **Agree the mapping.** Ask about unmapped columns and missing required fields. Use `ns_record_describe` with `filter` to find a field for a column the plan could not match. Do not invent field ids.
4. **Pick a key.** Choose a `keyField` that identifies a record (usually `externalId`; otherwise `companyName` or `email`) so duplicates in the file and records that already exist are found.
5. **Dry run.** Call `ns_import_dry_run` with the agreed `mapping` and `keyField`. Report `validRows` and `invalidRows`, the counts in `errorsByCheck`, a few example errors with their line numbers, and the `errorFile` path.
6. **Fix and repeat.** If any row is invalid, tell the user to fix the file and dry-run again. Do not call `ns_import_run` while `invalidRows` is above 0.
7. **Request approval to load.** When every row is valid, call `ns_import_run` with the same `file`, `recordType`, `mapping` and `keyField`, plus the `fileSha256` from the dry run, and no `approvalId`. It creates nothing and returns `approval_pending` with a preview and an `approvalId`. Show both, and tell the user a named approver runs `pnpm approvals approve <approvalId>` (valid 30 minutes once approved).
8. **Load.** Only after the user says it was approved, call `ns_import_run` again with exactly the same arguments plus `approvalId`. Report `created`, `failed` and `notAttempted`, and the `resultFile`. If the file was edited, the run is refused: dry-run again and request a new approval.

Limits: customers only, create only (no updates), at most 500 rows per file. The run stops after 5 consecutive failures; rows already created stay, and the result file shows which rows still need loading.

## What the dry run checks

- **required**: fields NetSuite always needs for the record type (customer and vendor: company name, or first and last name for individuals, and subsidiary). Forms and customisations can require more; say so.
- **type / format**: numbers are plain (`1250.50`, no thousands separators), dates `YYYY-MM-DD`, booleans `T/F`, emails look like emails.
- **reference**: subsidiary, currency, department, location and sales rep must match an existing record by internal id or name (currency also by symbol). `unverifiedReferences` lists reference fields it could not check; mention them.
- **duplicate-in-file / exists-in-netsuite**: the same `keyField` value twice in the file, or already on a record.

## Do not

- Do not create, update or upsert records any other way than `ns_import_run` with an approval (no suggestions to use the NetSuite CSV import assistant as a workaround).
- Do not pass an `approvalId` the user has not confirmed was approved, and do not change any argument between the approval request and the load.
- Do not read files outside the import folder or ask the user to paste file contents with sensitive data into chat.
- Do not repeat values shown as `[REDACTED]`.
