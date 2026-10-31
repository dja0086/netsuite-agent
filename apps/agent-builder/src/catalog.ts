/**
 * NetSuite AI Connector tools seen on /services/mcp/v1/all under NS Agent Integration (CP4 listing,
 * docs/cp4-parity-results.md; Phase 0 saw one more, unnamed here). Classified by what they can do.
 * A tool missing from this list is never allowed to run unasked: the toolset default is always_ask.
 */
export type ToolKind = "read" | "write" | "file_write" | "ui";

export const NETSUITE_TOOLS: Readonly<Record<string, ToolKind>> = {
  // Reads: data and metadata.
  ns_getSessionInfo: "read",
  ns_runCustomSuiteQL: "read",
  runCustomSuiteQL: "read",
  ns_getSuiteQLMetadata: "read",
  ns_getRecord: "read",
  ns_getRecordTypeMetadata: "read",
  ns_getRecordActionMetadata: "read",
  ns_getRecordTransformMetadata: "read",
  ns_listSavedSearches: "read",
  ns_runSavedSearch: "read",
  ns_listAllReports: "read",
  ns_runReport: "read",
  ns_getSubsidiaries: "read",
  ns_getAccountingBooks: "read",
  ns_getAccountingContexts: "read",
  ns_getNexusIds: "read",
  ns_getFile: "read",
  ns_searchFiles: "read",
  ns_getFolderByPath: "read",
  ns_getIdFromPath: "read",
  ns_getPathFromId: "read",
  searchCustomer: "read",
  getCustomerDetails: "read",
  getCustomerBalance: "read",
  getCustomerTransactions: "read",
  getItemDetails: "read",
  checkInventoryLevels: "read",
  nsagent_suiteql: "read",
  nsagent_record_get: "read",
  // Writes to records: allowed only when a use case needs them, and then always ask.
  createCustomer: "write",
  updateCustomer: "write",
  ns_createRecord: "write",
  ns_updateRecord: "write",
  ns_transformRecord: "write",
  ns_executeRecordAction: "write",
  // File cabinet writes: always disabled.
  ns_uploadFile: "file_write",
  ns_uploadFileApp: "file_write",
  ns_attachFile: "file_write",
  ns_detachFile: "file_write",
  // Interactive UI widgets for chat clients; not used by unattended agents.
  ns_fileCabinet_app: "ui",
  ns_getFileApp: "ui",
  ns_prompt_library_app: "ui",
  ns_report_filters_app: "ui",
  ns_selector_app: "ui",
};

export const toolsOfKind = (kind: ToolKind): string[] =>
  Object.entries(NETSUITE_TOOLS)
    .filter(([, k]) => k === kind)
    .map(([name]) => name);
