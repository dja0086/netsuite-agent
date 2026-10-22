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
| Reports | SuiteAnalytics Workbook (needed for SuiteQL) | Edit |
| Lists | Customers | Full (needed for delete: ADR 0006 `ns_record_delete`; creates: ADR 0005 `ns_import_run`). No edit tool exists. |
| Lists | Vendors, Items, Employees, Contacts | View |
| Lists | Subsidiaries, Currency, Accounts | View |
| Transactions | Find Transaction, plus each transaction type the agent may read | View |
| Lists | Custom record types the agent may read | View |

Known exception (2026-10-20): NetSuite forces **Other Addresses (`LIST_OTHER_ADDRESS`) = Full** onto this role whenever it is saved. `VIEW` is not a valid level for that key, and removing it from the XML (PR #3) did not stick: the next deploy added it back. It stays in the XML so the repo matches the account. No gateway tool writes addresses: the only write tools are `ns_search_save`, `ns_import_run` (customers) and `ns_record_delete` (customers), each behind an approval (ADRs 0004-0006). Recheck this exception in the CP5 permission review.

Add more record types only through a PR, reviewed by the NetSuite admin and security (CODEOWNERS enforces this for `netsuite/src/Objects/`).

## Never

- Administrator or any role with setup permissions beyond the two above. NetSuite's AI Connector refuses administrator roles by design; this gateway follows the same rule.
- Edit, Create or Full on any record beyond what an accepted ADR needs (today: Customers = Full for ADRs 0005 and 0006).
