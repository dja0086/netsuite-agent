# CP4 evidence: connector live

Status: **evidence complete 2026-10-30; waiting for owner sign-off.** CP4 is not passed until the owner signs off in the Delivery plan.

## Exit criteria

The Delivery plan's CP4 criteria: "Custom tools deployed as an account customization project; visible in an MCP client under the integration role; `N/query` only; results match the gateway." Evidence: client tool listing and parity test results.

Scope (owner decisions 2026-10-29): two read tools, `nsagent_suiteql` and `nsagent_record_get`; record describe stays in the gateway because `N/query` cannot do it. The integration role gains MCP Server Connection.

| # | Criterion | Result |
| --- | --- | --- |
| 1 | Custom tools deployed as an account customization project | Met |
| 2 | Visible in an MCP client under the integration role | Met |
| 3 | `N/query` only | Met |
| 4 | Results match the gateway | Met (5/5) |

## 1. Deployed as an account customization project

- Role: `ADMI_MCP_SERVER` (MCP Server Connection, Full) added to `customrole_ns_agent` in PR [#20](https://github.com/dja0086/netsuite-agent/pull/20), merged as b546be1. Table in `docs/netsuite-role.md`.
- Toolset: `custtoolset_nsagent_read` "NS Agent - Read tools" in PR [#19](https://github.com/dja0086/netsuite-agent/pull/19), merged as 57fec3e. `exposetoaiconnector` T; one visibility permission, `TRAN_FIND` View, which the integration role holds. Script `SuiteScripts/ns_agent/tools/agent_tools.js`, schema `agent_tools_schema.json`.
- Validate-only run [40926400688](https://github.com/dja0086/netsuite-agent/actions/runs/40926400688): 0 errors.
- Deploy run [40937190598](https://github.com/dja0086/netsuite-agent/actions/runs/40937190598) from main at 57fec3e, approved by the owner (2026-10-29 19:11 UTC): `DEPLOY SUMMARY Status: SUCCESS`, steps 44/44, 0 errors, account ID TSTDRV1755417. Server validation listed `custtoolset_nsagent_read (custtoolset)` and `customrole_ns_agent (role)`.
- Check afterwards (Administrator, read only): Customization > Scripting > Custom Tools lists "NS Agent - Read tools", active, permission Find Transaction - View, no SuiteApp.

## 2. Visible under the integration role

Full listing and session excerpt: `docs/cp4-parity-results.md`, "Run on /all (2026-10-30)".

- Client: claude.ai custom connector "NetSuite All", URL `https://tstdrv1755417.suitetalk.api.netsuite.com/services/mcp/v1/all`, signed in by the owner as NS Agent Integration.
- `ns_getSessionInfo` (2026-10-30 16:34 UTC): account TSTDRV1755417, role `customrole_ns_agent`.
- The connector lists 44 tools. `nsagent_suiteql` and `nsagent_record_get` are both listed, without a prefix.

What it took, for whoever connects a client next:

- The URL must be `/services/mcp/v1/all`. The built-in claude.ai "NetSuite" connector uses `/services/mcp/v1/suiteapp/com.netsuite.mcpstandardtools`, which serves only the MCP Standard Tools SuiteApp, so account toolsets never appear there.
- The role is fixed per OAuth consent (Setup > Users/Roles > OAuth 2.0 Authorized Applications). Reconnecting reuses the old consent; to change role, revoke it first and sign in again with the integration role.
- Claude Code's own MCP client cannot sign in to this endpoint: NetSuite's dynamic client registration rejects its redirect URIs (`invalid_redirect_uri`). claude.ai's https callback is accepted.

## 3. `N/query` only

- `agent_tools.js` loads only `N/query` and `../lib/tool_guards` (which loads no NetSuite modules). No `N/record`, `N/http(s)` or other module.
- `nsagent_suiteql` accepts one SELECT statement (no `;`, no comments), runs it with `query.runSuiteQLPaged`, and returns at most 200 rows.
- `nsagent_record_get` checks the type and field identifiers and a positive integer id, then runs `SELECT <fields> FROM <type> WHERE id = ?` with the id bound.
- Both tools are annotated `readOnlyHint: true`.
- Guard tests: `tests/netsuite/agent-tools.test.ts` (17/17, 2026-10-30), including `DELETE FROM customer` returning an error without calling `N/query`. The live guard call was not sent: Claude Code's safety check refused to send a DELETE statement to the account. The deployed script is the tested file.

## 4. Parity with the gateway

Run 2026-10-30 16:34 UTC, connector (`nsagent_*`) against the gateway (`ns_suiteql`, `ns_record_get`, M2M, same role). Details in `docs/cp4-parity-results.md`.

| Case | What | Match |
| --- | --- | --- |
| S1 | Customer count (1014) | Yes |
| S2 | Invoice counts by status (A 504, B 601) | Yes |
| S3 | First 10 customers by id, with more pages | Yes |
| R1 | Customer 22, four fields | Yes |
| R2 | Latest invoice 46871, six fields | Yes |

**Parity 5/5.** Differences are in shape only and are written down in the results file: numbers against SuiteQL strings; SuiteQL lowercase keys against REST camelCase; the user's date format against ISO; status code `A` against "Open"; `foreigntotal` (not offered by the REST Record API) checked against `total` and currency.

## Finding for CP5 (permission review)

`/all` serves every toolset the role can see, including Oracle's write tools: `createCustomer`, `updateCustomer`, `ns_createRecord`, `ns_updateRecord`, `ns_executeRecordAction`, `ns_transformRecord`, `ns_uploadFile`, `ns_attachFile`, `ns_detachFile`. The older Standard Tools URL already served `ns_createRecord` and `ns_updateRecord`. Under NS Agent Integration (Customers = Full, File Cabinet = Edit), an MCP client signed in with this role can write customers and files directly, outside the approval path of ADRs 0004-0006. None was called during CP4.

Options for CP5: narrow the role, use a separate role for AI Connector sign-ins that has only view permissions plus MCP Server Connection, or find an endpoint that serves only `custtoolset_nsagent_read`. Until then, disconnect the "NetSuite All" connector when it is not in use.

## What CP4 rests on (merged PRs)

| PR | What |
| --- | --- |
| [#20](https://github.com/dja0086/netsuite-agent/pull/20) | MCP Server Connection on the integration role |
| [#19](https://github.com/dja0086/netsuite-agent/pull/19) | `custtoolset_nsagent_read`, `agent_tools.js`, `tool_guards.js`, schema, guard tests |
