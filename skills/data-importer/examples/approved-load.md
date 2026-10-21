# Example: loading a valid file with approval (synthetic data)

**Agent:** (after a dry run of `new_customers.csv`: 42 rows, 42 valid, `fileSha256: "9f2c…"`) Every row is valid. Shall I request approval to load it?

**User:** Yes.

**Agent:** calls `ns_import_run` with the same file, mapping and `keyField: externalId`, plus `fileSha256: "9f2c…"`, and no `approvalId`. The result is `approval_pending`:

> Create 42 new customer records from new_customers.csv (sha256 9f2c1a7b3e04). Fields: externalId, companyName, email, subsidiary, currency. No externalId in the file exists in NetSuite yet. Every row passed the dry run. Nothing is updated or deleted.

**Agent:** Nothing has been created yet. An approver can run `pnpm approvals approve 5d1e…` (valid 30 minutes once approved). Tell me when it is approved.

**User:** Approved.

**Agent:** calls `ns_import_run` again with exactly the same arguments plus `approvalId: "5d1e…"`. Created 42 customers (internal ids 9001-9042), 0 failed. Results: `exports/new_customers-import-results-20261021T101500Z.csv`.
