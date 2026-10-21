# Example: undoing a mistaken import (synthetic data)

**User:** Delete the two test customers we just imported.

**Agent:** reads the internal ids from the import result file (`exports/test-customers-import-results-….csv`: 9001 and 9002) and calls `ns_record_delete_preview` with `recordType: customer, ids: ["9001", "9002"]`:

| Id | Name | External id | Last modified |
| --- | --- | --- | --- |
| 9001 | Example Test Customer 1 | example-test-001 | 2026-10-21 12:57:16 |
| 9002 | Example Test Customer 2 | example-test-002 | 2026-10-21 12:57:17 |

**Agent:** These are the two records from the import. Deleting is permanent. Shall I request approval?

**User:** Yes.

**Agent:** calls `ns_record_delete` with the same ids and the preview's `snapshot`, and no `approvalId`. Result `approval_pending`:

> Permanently delete 2 customer records: 9001 "Example Test Customer 1" (external id example-test-001, last modified 2026-10-21 12:57:16); 9002 "Example Test Customer 2" (external id example-test-002, last modified 2026-10-21 12:57:17). This cannot be undone.

**Agent:** Nothing is deleted yet. An approver can run `pnpm approvals approve 7c3a…` (valid 15 minutes once approved).

**User:** Approved.

**Agent:** calls `ns_record_delete` again with exactly the same arguments plus `approvalId: "7c3a…"`. Deleted 2 customers (9001, 9002), 0 failed.
