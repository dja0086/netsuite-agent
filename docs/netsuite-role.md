# Integration role: customrole_ns_agent

The gateway runs as one dedicated, web-services-only role with view-level permissions. Create it once by hand in the sandbox, then bring it under source control so every later permission change is reviewed.

## Steps (NetSuite admin, Phase 0)

1. Setup > Users/Roles > Manage Roles > New. Name **NS Agent Integration**, ID **`_ns_agent`** (NetSuite prefixes it to `customrole_ns_agent`).
2. Check **Web Services Only Role**.
3. Add the permissions below.
4. Import it into the repo so the XML matches the account exactly:
   ```bash
   cd netsuite
   suitecloud object:import --type role --scriptid customrole_ns_agent --destinationfolder /Objects
   ```
5. Open a PR with the imported XML. From then on, change permissions only through PRs.

Importing beats hand-writing the XML: permission keys are easy to get wrong, and an invalid key fails the deploy.

## Permissions (Phase 1, read-only)

| Area | Permission | Level |
| --- | --- | --- |
| Setup | REST Web Services | Full |
| Setup | Log in using OAuth 2.0 Access Tokens | Full |
| Reports | SuiteAnalytics Workbook (needed for SuiteQL) | Edit |
| Lists | Customers, Vendors, Items, Employees, Contacts | View |
| Lists | Subsidiaries, Currency, Accounts | View |
| Transactions | Find Transaction, plus each transaction type the agent may read | View |
| Lists | Custom record types the agent may read | View |

Add more record types only through a PR, reviewed by the NetSuite admin and security (CODEOWNERS enforces this for `netsuite/src/Objects/`).

## Never

- Administrator or any role with setup permissions beyond the two above. NetSuite's AI Connector refuses administrator roles by design; this gateway follows the same rule.
- Edit, Create or Full on any record in Phase 1.
