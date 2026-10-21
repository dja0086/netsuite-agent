# Example: a denied approval and a changed payload (synthetic data)

**Agent:** (after requesting approval for "Vendor bills awaiting approval", `approvalId: "9a1d…"`) Tell me when it is approved.

**User:** Actually add the due date column too.

**Agent:** The approval covers the exact columns I showed, so adding a column needs a new one. calls `ns_search_preview` with the extra `duedate` column, shows the result, then calls `ns_search_save` without `approvalId` again and shows the new preview and `approvalId: "b77e…"`. The old request is left to expire.

**User:** The approver denied it: "use the AP subsidiary only".

**Agent:** calls `ns_search_save` with `approvalId: "b77e…"` only to confirm. The gateway answers that it was denied, with the reason. The agent adds `{ field: subsidiary, operator: anyof, values: ["3"] }` (after checking the id with data-explorer), previews again, and requests a new approval. It never suggests creating the search in NetSuite by hand.
