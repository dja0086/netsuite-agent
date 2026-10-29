# Integration role: customrole_ns_agent

The gateway runs as one dedicated integration role: View on what the agent reads, Full on Customers for the approved import and delete tools, nothing else. It was created once by hand, then brought under source control so every later permission change is reviewed.

## Steps (NetSuite admin, Phase 0)

1. Setup > Users/Roles > Manage Roles > New. Name **NS Agent Integration**, ID **`_ns_agent`** (NetSuite prefixes it to `customrole_ns_agent`).
2. Leave **Web Services Only Role** unchecked: with it checked, OAuth 2.0 calls to RESTlets fail with `InsufficientPermissions` in the Login Audit Trail (REST and SuiteQL still work). The role is assigned to employee 2815 "Integration User", the account's integration user for this use case (decided 2026-10-21; no dedicated employee).
3. Add the permissions below.
4. Import it into the repo so the XML matches the account exactly:
   ```bash
   cd netsuite
   suitecloud object:import --type role --scriptid customrole_ns_agent --destinationfolder /Objects
   ```
5. Open a PR with the imported XML. From then on, change permissions only through PRs.

Importing beats hand-writing the XML: permission keys are easy to get wrong, and an invalid key fails the deploy.

## Permissions (current)

| Area | Permission | Level |
| --- | --- | --- |
| Setup | REST Web Services | Full |
| Setup | Log in using OAuth 2.0 Access Tokens | Full |
| Setup | MCP Server Connection (`ADMI_MCP_SERVER`) | Full (CP4: lets this role use the NetSuite AI Connector Service, where the `custtoolset_nsagent_read` custom tools appear; owner decision 2026-10-29) |
| Reports | SuiteAnalytics Workbook (needed for SuiteQL) | Edit |
| Lists | Customers | Full (needed for delete: ADR 0006 `ns_record_delete`; creates: ADR 0005 `ns_import_run`). No edit tool exists. |
| Lists | Vendors, Items, Employees, Contacts | View |
| Lists | Subsidiaries, Currency, Accounts | View |
| Transactions | Find Transaction, plus each transaction type the agent may read | View |
| Lists | Custom record types the agent may read | View |
| Lists | Custom Record Entries (`LIST_CUSTRECORDENTRY`) | View (owner decision 2026-10-22). Needed by the PDF preview RESTlet, see below. |

Custom Record Entries (2026-10-22): the demo account's Pay When Paid SuiteApp reads its preferences record (`customrecord_nsts_pwp_preferences`) whenever a script loads an invoice, sales order, credit memo or vendor bill. That record type's access type is "Require Custom Record Entries Permission", so NetSuite ignores a per-record-type permission on the role (tried and deployed; the error stayed) and only Custom Record Entries works. Without it, `record.load` in the PDF preview RESTlet fails with `INSUFFICIENT_PERMISSION` for those four types. Breadth: View on every custom record type with that access type. Of the account's 411 custom record types, SDF could read 66: 30 use this access type, 20 need no permission, 16 use their own permission list; the other 345 are locked SuiteApp objects whose access type cannot be read. The gateway's generic read tools (`ns_suiteql`, `ns_record_get`) can read those custom records as well; read-only, no write tool covers them. Recheck in the CP5 permission review.

Known exception (2026-10-20): NetSuite forces **Other Addresses (`LIST_OTHER_ADDRESS`) = Full** onto this role whenever it is saved. `VIEW` is not a valid level for that key, and removing it from the XML (PR #3) did not stick: the next deploy added it back. It stays in the XML so the repo matches the account. No gateway tool writes addresses: the only write tools are `ns_search_save`, `ns_import_run` (customers) and `ns_record_delete` (customers), each behind an approval (ADRs 0004-0006). Recheck this exception in the CP5 permission review.

Add more record types only through a PR, reviewed by the NetSuite admin and security (CODEOWNERS enforces this for `netsuite/src/Objects/`).

## Never

- Administrator or any role with setup permissions beyond the two above. NetSuite's AI Connector refuses administrator roles by design; this gateway follows the same rule.
- Edit, Create or Full on any record beyond what an accepted ADR needs (today: Customers = Full for ADRs 0005 and 0006).
