/**
 * NetSuite AI Connector custom tools for the ns-agent project (CP4): the gateway's top read tools, packaged to run
 * inside NetSuite under the connected user's role. N/query only: no record writes, no outbound calls.
 * Tools are declared in agent_tools_schema.json and exposed by the toolset object custtoolset_nsagent_read.
 *
 *   nsagent_suiteql    { query, limit? }        -> { rows, rowCount, hasMore }    (as the gateway's ns_suiteql)
 *   nsagent_record_get { type, id, fields }     -> { record }                     (as ns_record_get with fields)
 *
 * Errors come back as { error } so the AI client can read and act on them.
 *
 * @NApiVersion 2.1
 * @NScriptType CustomTool
 * @NModuleScope SameAccount
 */
define(['N/query', '../lib/tool_guards'], (query, guards) => {
  const errorResult = (e) => ({
    error: e instanceof guards.ToolInputError ? e.message : `NetSuite rejected the query: ${String((e && e.message) || e).slice(0, 300)}`,
  });

  return {
    nsagent_suiteql: async (args) => {
      try {
        const sql = guards.assertSelectOnly(args.query);
        const limit = guards.rowLimit(args.limit);
        // runSuiteQLPaged pages at 5..1000 rows; one page of at least `limit` rows is all this tool returns.
        const paged = query.runSuiteQLPaged({ query: sql, pageSize: Math.max(5, limit) });
        const rows = paged.count > 0 ? paged.fetch({ index: 0 }).data.asMappedResults().slice(0, limit) : [];
        return { rows, rowCount: rows.length, hasMore: paged.count > rows.length };
      } catch (e) {
        return errorResult(e);
      }
    },

    nsagent_record_get: async (args) => {
      try {
        const type = guards.identifier(args.type, 'type');
        const id = guards.recordId(args.id);
        const fields = guards.fieldList(args.fields);
        // Identifiers are checked above; the id is bound as a parameter.
        const rows = query.runSuiteQL({ query: `SELECT ${fields.join(', ')} FROM ${type} WHERE id = ?`, params: [id] }).asMappedResults();
        if (rows.length === 0) return { error: `No ${type} with internal id ${id}, or this role cannot see it` };
        return { record: rows[0] };
      } catch (e) {
        return errorResult(e);
      }
    },
  };
});
