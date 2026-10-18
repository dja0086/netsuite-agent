import { callRestlet, getRecord, suiteql } from "@ns-agent/ns-client";
import { assertSelectOnly } from "@ns-agent/suiteql";
import { z } from "zod";
import { MAX_ROWS_TO_MODEL, defineTool } from "../registry";

/** RESTlet deployed by netsuite/src/Objects/customscript_ns_agent_explore_rl.xml */
export const EXPLORE_RESTLET = {
  scriptId: "customscript_ns_agent_explore_rl",
  deployId: "customdeploy_ns_agent_explore_rl",
} as const;

const recordType = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "a NetSuite record type id such as customer, salesorder or customrecord_x")
  .describe("NetSuite record type id, e.g. customer, vendor, salesorder, invoice, item");

export const nsCatalogList = defineTool({
  name: "ns_catalog_list",
  title: "List NetSuite record types",
  description:
    "Lists the record types the integration role can access through the REST Record API. " +
    "Use first when you do not know a record type's id. Optional filter matches part of the name.",
  writes: false,
  input: z.object({
    filter: z.string().max(60).optional().describe("Case-insensitive substring, e.g. 'order' or 'customrecord'"),
  }),
  async handler({ filter }, { metadata }) {
    const all = await metadata.recordTypes();
    const needle = filter?.toLowerCase();
    const types = needle ? all.filter((t) => t.toLowerCase().includes(needle)) : all;
    return { count: types.length, recordTypes: types };
  },
});

export const nsRecordDescribe = defineTool({
  name: "ns_record_describe",
  title: "Describe a NetSuite record type",
  description:
    "Returns the fields of one record type: id, label, type, whether it is custom, and the record it references. " +
    "Call before writing SuiteQL or reading a record so you use real field ids.",
  writes: false,
  input: z.object({
    type: recordType,
    customOnly: z.boolean().default(false).describe("Return only custom fields (ids starting with cust)"),
  }),
  async handler({ type, customOnly }, { metadata }) {
    const fields = await metadata.fields(type);
    const selected = customOnly ? fields.filter((f) => f.custom) : fields;
    return { type, fieldCount: selected.length, fields: selected };
  },
});

export const nsSuiteql = defineTool({
  name: "ns_suiteql",
  title: "Run a read-only SuiteQL query",
  description:
    "Runs one SuiteQL SELECT and returns up to 200 rows. SuiteQL is Oracle-flavoured: use ROWNUM, NVL, ||, " +
    "TO_DATE('2026-01-31','YYYY-MM-DD'), BUILTIN.DF(field) for display values; no WITH/CTEs, LIMIT or OFFSET. " +
    "Aggregate in SQL instead of fetching many rows. Use offset to page; hasMore tells you if rows remain.",
  writes: false,
  input: z.object({
    q: z.string().min(8).max(20_000).describe("A single SuiteQL SELECT statement"),
    limit: z.number().int().min(1).max(MAX_ROWS_TO_MODEL).default(50),
    offset: z.number().int().min(0).max(99_000).default(0),
  }),
  async handler({ q, limit, offset }, { ns }) {
    const page = await suiteql(ns, assertSelectOnly(q), { limit, offset });
    return {
      rows: page.items,
      rowCount: page.items.length,
      offset: page.offset,
      totalResults: page.totalResults,
      hasMore: page.hasMore,
    };
  },
});

export const nsRecordGet = defineTool({
  name: "ns_record_get",
  title: "Read one NetSuite record",
  description:
    "Reads a single record by internal id or external id (eid:<value>) through the REST Record API. " +
    "Pass fields to keep the response small; sublists are only included when expandSubResources is true.",
  writes: false,
  input: z.object({
    type: recordType,
    id: z.string().regex(/^(\d+|eid:[^/?#\s]+)$/, "an internal id like 123 or an external id like eid:CUST-001"),
    fields: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)).max(50).optional(),
    expandSubResources: z.boolean().default(false),
  }),
  async handler({ type, id, fields, expandSubResources }, { ns }) {
    return getRecord(ns, type, id, { fields, expandSubResources });
  },
});

export const nsGlobalSearch = defineTool({
  name: "ns_global_search",
  title: "NetSuite global search",
  description:
    "Keyword search across records, like the NetSuite global search bar. Supports prefixes such as 'cu:' (customer) " +
    "or 'inv:' (invoice). Returns record type, id and display name; use ns_record_get for details.",
  writes: false,
  input: z.object({
    keywords: z.string().min(2).max(100),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  async handler({ keywords, limit }, { ns }) {
    return callRestlet(ns, { ...EXPLORE_RESTLET, body: { action: "globalSearch", keywords, limit } });
  },
});

export const dataTools = [nsCatalogList, nsRecordDescribe, nsSuiteql, nsRecordGet, nsGlobalSearch];
