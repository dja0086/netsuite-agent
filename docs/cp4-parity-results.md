# CP4 visibility check and parity test: results

## Run on /all (2026-10-30)

Run: 2026-10-30 16:34 UTC. Connector: the claude.ai custom connector "NetSuite All" (server id 23c480de…), URL `https://tstdrv1755417.suitetalk.api.netsuite.com/services/mcp/v1/all`, signed in by the owner as NS Agent Integration. Gateway: the `netsuite-agent` MCP server (M2M, same role). Read only: no writes were made.

Verdict: **Parity 5/5.** Both nsagent tools are visible under the integration role. The live guard call was blocked before it was sent (see Guard).

### Why not the Claude Code `netsuite-all` server

Its `/mcp` sign-in fails before the browser opens. NetSuite's dynamic client registration (`/services/rest/auth/oauth2/v1/register`) rejects both redirect URIs Claude Code offers (`claude://claude.ai/mcp-auth-callback/sdk` and `http://localhost:<port>/callback`) with `{"error":"invalid_redirect_uri"}`. claude.ai's https callback is accepted, so the run used a claude.ai custom connector instead. To use Claude Code's own client, NetSuite would need a pre-registered integration record with a fixed localhost callback.

### Session role (`ns_getSessionInfo`, excerpt)

```json
{
  "capturedAt": "2026-10-30T16:34:25.001Z",
  "account": { "accountId": "TSTDRV1755417", "environmentType": "PRODUCTION", "version": "2026.2" },
  "role": { "roleId": "customrole_ns_agent", "roleCenter": "ACCOUNTCENTER", "subsidiary": 12 }
}
```

Granted permissions match `docs/netsuite-role.md`: `ADMI_MCP_SERVER` Full, `LIST_CUSTJOB` Full, `TRAN_FIND` View, among others.

### Connector tool listing (44 tools)

- **Ours (`custtoolset_nsagent_read`):** `nsagent_suiteql`, `nsagent_record_get`. **Both are listed**, without a prefix.
- **MCP Tools SuiteApp:** `checkInventoryLevels`, `createCustomer`, `getCustomerBalance`, `getCustomerDetails`, `getCustomerTransactions`, `getItemDetails`, `runCustomSuiteQL`, `searchCustomer`, `updateCustomer`.
- **MCP Standard Tools SuiteApp:** `ns_attachFile`, `ns_createRecord`, `ns_detachFile`, `ns_executeRecordAction`, `ns_fileCabinet_app`, `ns_getAccountingBooks`, `ns_getAccountingContexts`, `ns_getFile`, `ns_getFileApp`, `ns_getFolderByPath`, `ns_getIdFromPath`, `ns_getNexusIds`, `ns_getPathFromId`, `ns_getRecord`, `ns_getRecordActionMetadata`, `ns_getRecordTransformMetadata`, `ns_getRecordTypeMetadata`, `ns_getSessionInfo`, `ns_getSubsidiaries`, `ns_getSuiteQLMetadata`, `ns_listAllReports`, `ns_listSavedSearches`, `ns_prompt_library_app`, `ns_report_filters_app`, `ns_runCustomSuiteQL`, `ns_runReport`, `ns_runSavedSearch`, `ns_searchFiles`, `ns_selector_app`, `ns_transformRecord`, `ns_updateRecord`, `ns_uploadFile`, `ns_uploadFileApp`.

This confirms the earlier "likely cause": the old connector used the Standard Tools SuiteApp URL, and `/all` serves every toolset, ours included.

### Parity cases

| Case | Query / arguments | Connector (`nsagent_*`) | Gateway (`ns_*`) | Match |
| --- | --- | --- | --- | --- |
| S1 | `SELECT COUNT(c.id) AS n FROM customer c` | n = 1014 | n = "1014" | Yes |
| S2 | `SELECT t.status, COUNT(t.id) AS n FROM transaction t WHERE t.type = 'CustInvc' GROUP BY t.status ORDER BY t.status` | A 504, B 601 | A "504", B "601" | Yes |
| S3 | `SELECT c.id, c.entityid, c.companyname FROM customer c ORDER BY c.id`, limit 10 | ids 22, 24, 29, 30, 31, 32, 33, 34, 35, 36; hasMore true | same 10 ids, entityids and company names in the same order; hasMore true, totalResults 1014 | Yes |
| R1 | customer 22, fields `id, entityid, companyname, email` | 22, Bay Media Research, Bay Media Research, maryc@baymedia.com | same values | Yes |
| R2 | invoice 46871 (`MAX(t.id)` for `CustInvc`, 46871 on both sides), fields `id, tranid, trandate, entity, foreigntotal, status` | 46871, 1716, 8/1/2026, 294, 2500, A | 46871, 1716, 2026-08-01, 294 (Hogan Software), 2500 USD (`total`), Open | Yes |

Shape differences (values equal after normalising):

- The connector returns numbers (`1014`, `22`); the gateway returns SuiteQL strings (`"1014"`, `"22"`).
- `nsagent_record_get` wraps the result in `{ record: {...} }` with SuiteQL lowercase keys (`entityid`). The gateway's REST Record API returns camelCase (`entityId`, `tranDate`) and references as `{ id, refName }`.
- R2 date: the connector shows the user's date preference (`M/D/YYYY`, so `8/1/2026`); REST returns ISO (`2026-08-01`).
- R2 status: the connector returns the SuiteQL code `A`; REST returns `Open`. Invoice status A is Open.
- R2 amount: the REST Record API has no `foreigntotal` and silently omits it. A second gateway call with `total, currency` returned 2500 USD.

### Guard

- **Live:** not run. Claude Code's auto-mode safety check refused to send `DELETE FROM customer` to the live account, so the call never reached NetSuite. Nothing changed: no write was attempted on either side.
- **Offline evidence:** `tests/netsuite/agent-tools.test.ts` passes (17/17, run 2026-10-30). It checks that `nsagent_suiteql` given `DELETE FROM customer` returns `{ error: "…Only SELECT…" }` without calling `N/query`. The deployed script is the same `agent_tools.js` with `guards.assertSelectOnly`.
- To finish the live check, the owner can run the guard query through the connector themselves, or allow the call for this tool.

### Finding for CP5 (permission review)

`/all` also serves write tools from the two Oracle SuiteApps: `createCustomer`, `updateCustomer`, `ns_createRecord`, `ns_updateRecord`, `ns_executeRecordAction`, `ns_transformRecord`, `ns_uploadFile`, `ns_attachFile` and `ns_detachFile`. Under this role (Customers = Full, File Cabinet = Edit), a client connected to `/all` could write customers and files directly, outside the approval path in ADRs 0004-0006. None was called in this run. Options: narrow the role's permissions, or find a URL that serves only our toolset. `/suiteapp/<applicationid>` serves one SuiteApp's tools; whether an equivalent exists for an account toolset has not been checked.

## Earlier run (2026-10-30 00:03 UTC, Standard Tools URL), kept as history

Run: 2026-10-30 00:03 UTC, from a fresh Claude Code session whose NetSuite connector (claude.ai connector "NetSuite", server id 89b58377…) was loaded after the owner re-authorized it.

## Result: stopped at step 2. The role is right, but the custom tools are not served

The connector now runs as the integration role. Its tool list still does not include `nsagent_suiteql` or `nsagent_record_get`. The parity test needs those tools on the connector side, so it was not run. The guard check needs `nsagent_suiteql`, so it was not run either.

### Session role (`ns_getSessionInfo`, excerpt)

```json
{
  "capturedAt": "2026-10-30T00:03:41.399Z",
  "account": { "accountId": "TSTDRV1755417", "environmentType": "PRODUCTION", "version": "2026.2" },
  "role": { "roleId": "customrole_ns_agent", "roleCenter": "ACCOUNTCENTER", "subsidiary": 12 }
}
```

- Role: `customrole_ns_agent` (NS Agent Integration). This is the expected role, the same one the gateway uses over M2M.
- Permissions seen include `ADMI_MCP_SERVER` (Full), `ADMI_LOGIN_OAUTH2` (Full) and `TRAN_FIND` (View). `TRAN_FIND` View is the toolset's only visibility permission, so this role meets it.

### Connector tool listing (31 tools)

`ns_attachFile`, `ns_createRecord`, `ns_detachFile`, `ns_executeRecordAction`, `ns_fileCabinet_app`, `ns_getAccountingBooks`, `ns_getAccountingContexts`, `ns_getFile`, `ns_getFileApp`, `ns_getFolderByPath`, `ns_getIdFromPath`, `ns_getNexusIds`, `ns_getPathFromId`, `ns_getRecord`, `ns_getRecordActionMetadata`, `ns_getRecordTransformMetadata`, `ns_getRecordTypeMetadata`, `ns_getSessionInfo`, `ns_getSubsidiaries`, `ns_getSuiteQLMetadata`, `ns_listAllReports`, `ns_prompt_library_app`, `ns_report_filters_app`, `ns_runCustomSuiteQL`, `ns_runReport`, `ns_searchFiles`, `ns_selector_app`, `ns_transformRecord`, `ns_updateRecord`, `ns_uploadFile`, `ns_uploadFileApp`.

- `nsagent_suiteql` and `nsagent_record_get` are **not listed**, with or without a prefix. A ToolSearch for "nsagent" returns nothing.
- Compared with the Power User run (33 tools), `ns_listSavedSearches` and `ns_runSavedSearch` dropped out. So the connector's tool list did refresh for the new role. It just does not include the custom toolset.
- Context: the toolset `custtoolset_nsagent_read` was deployed by `deploy-sdf` run 40937190598 (2026-10-29 19:11 UTC, 44/44 steps, 0 errors). It is listed and active under Customization > Scripting > Custom Tools (see below).

## Parity cases

Not run: the connector does not serve the nsagent tools.

| Case | Query / arguments | Connector | Gateway | Match |
| --- | --- | --- | --- | --- |
| S1 | `SELECT COUNT(c.id) AS n FROM customer c` | not run | not run | — |
| S2 | `SELECT t.status, COUNT(t.id) AS n FROM transaction t WHERE t.type = 'CustInvc' GROUP BY t.status ORDER BY t.status` | not run | not run | — |
| S3 | `SELECT c.id, c.entityid, c.companyname FROM customer c ORDER BY c.id`, limit 10 | not run | not run | — |
| R1 | customer, first id from S3, fields `id, entityid, companyname, email` | not run | not run | — |
| R2 | latest invoice, fields `id, tranid, trandate, entity, foreigntotal, status` | not run | not run | — |

Guard check (`nsagent_suiteql` with `DELETE FROM customer`): not run.

Parity: 0/5 run.

## Open question

Why does the connector, under a role that meets the toolset's permission, not list the toolset's tools? Not established by this run. Candidates to check, none verified:

- the AI Connector may only expose custom tools from SuiteApps, or need a per-toolset or per-role switch beyond `exposetoaiconnector`;
- the Custom Tools page shows "Updated ---" for this toolset only, which may mean it was never registered with the connector;
- the claude.ai side may cache tools by server version.

## NetSuite UI check (2026-10-30, Administrator role, read only)

- **Customization > Scripting > Custom Tools:** "NS Agent - Read tools" is listed and not inactive. It has permission Find Transaction - View and the tool `nsagent_suiteql` (description as in `agent_tools_schema.json`). Updated shows "---", and it has no SuiteApp, as expected for an ACP object.
- **Setup > Users/Roles > OAuth 2.0 Authorized Applications:** the Claude AI authorization for the owner's login was consent #4, created 2026-10-18 12:30, scope MCP, role **Power User**. Reconnecting had reused it. The only consents with role NS Agent Integration were #5 (NS Agent Gateway, the M2M gateway) and #10 (SuiteReact MCP (local), 2026-10-29).
- On 2026-10-30 the owner revoked consent #4 (Claude AI, Power User) and re-authorized the connector as NS Agent Integration.

## Likely cause (2026-10-30, not yet verified)

- Oracle's AI Connector FAQ says a client gets every MCP tool, standard and custom, from `https://<accountid>.suitetalk.api.netsuite.com/services/mcp/v1/all`.
- A `/services/mcp/v1/suiteapp/<applicationid>` URL serves only that SuiteApp's tools.
- The connector's tools match the "MCP Standard Tools" SuiteApp toolsets on the Custom Tools page: File Cabinet, Record, Record Action, Reporting, Runtime Session Information and Prompt Library.
- It serves none of the "MCP Tools" SuiteApp toolsets (Customer Management, Financial, General, Sales and Orders, SuiteQL), and none of ours.
- So the connector is probably pointed at the `com.netsuite.mcpstandardtools` endpoint, not `/all`.
- Next step: connect an MCP client to `https://tstdrv1755417.suitetalk.api.netsuite.com/services/mcp/v1/all` as NS Agent Integration, then rerun the listing and the parity test.
