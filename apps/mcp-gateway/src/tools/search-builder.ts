import { callRestlet, type NsRequester } from "@ns-agent/ns-client";
import { z } from "zod";
import { defineTool, type ToolDef } from "../registry";

/** RESTlet deployed by netsuite/src/Objects/customscript_ns_agent_search_rl.xml */
export const SEARCH_RESTLET = {
  scriptId: "customscript_ns_agent_search_rl",
  deployId: "customdeploy_ns_agent_search_rl",
} as const;

/** N/search operators (search.Operator). The RESTlet checks again against the live enum. */
export const SEARCH_OPERATORS = [
  "after", "allof", "any", "anyof", "before", "between", "contains", "doesnotcontain", "doesnotstartwith",
  "equalto", "greaterthan", "greaterthanorequalto", "haskeywords", "is", "isempty", "isnot", "isnotempty",
  "lessthan", "lessthanorequalto", "noneof", "notafter", "notallof", "notbefore", "notbetween", "notequalto",
  "notgreaterthan", "notgreaterthanorequalto", "notlessthan", "notlessthanorequalto", "noton", "notonorafter",
  "notonorbefore", "notwithin", "on", "onorafter", "onorbefore", "startswith", "within",
] as const;

const id = (what: string) =>
  z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, `${what} must be a field or record id (letters, digits and _ only)`);

const filter = z
  .object({
    field: id("field"),
    join: id("join field").optional(),
    operator: z.enum(SEARCH_OPERATORS, { message: "unknown operator; use an N/search operator such as anyof, is, onorbefore" }),
    values: z.array(z.union([z.string().max(200), z.number(), z.boolean()])).max(50).default([]),
  })
  .strict();

const column = z
  .object({
    field: id("field"),
    join: id("join field").optional(),
    summary: z.enum(["group", "count", "sum", "avg", "min", "max"]).optional(),
    sort: z.enum(["asc", "desc"]).optional(),
    label: z.string().max(60).optional(),
  })
  .strict();

const searchShape = {
  recordType: id("recordType").describe("Search type, e.g. transaction, customer, invoice, salesorder, vendorbill"),
  filters: z.array(filter).max(20).default([]).describe("Conditions, all combined with AND"),
  columns: z.array(column).min(1).max(30),
};

type SearchSpec = { recordType: string; filters: z.infer<typeof filter>[]; columns: z.infer<typeof column>[] };

interface PreviewResult {
  recordType: string;
  totalCount: number;
  columns: string[];
  rows: Record<string, unknown>[];
}

function preview(ns: NsRequester, spec: SearchSpec, limit: number): Promise<PreviewResult> {
  return callRestlet<PreviewResult>(ns, { ...SEARCH_RESTLET, body: { action: "preview", ...spec, limit } });
}

const describeFilter = (f: z.infer<typeof filter>) =>
  `${f.join ? `${f.join}.` : ""}${f.field} ${f.operator}${f.values.length ? ` ${f.values.map((v) => JSON.stringify(v)).join(", ")}` : ""}`;
const describeColumn = (c: z.infer<typeof column>) =>
  `${c.summary ? `${c.summary.toUpperCase()}(` : ""}${c.join ? `${c.join}.` : ""}${c.field}${c.summary ? ")" : ""}${c.sort ? ` ${c.sort}` : ""}`;

export const nsSearchPreview = defineTool({
  name: "ns_search_preview",
  title: "Preview a saved search",
  description:
    "Runs a search definition without saving it: returns the total match count and up to 50 rows. " +
    "Use it to check filters and columns before ns_search_save. Filters are ANDed; operators are N/search " +
    "operators (anyof, is, onorbefore, ...); summary columns (group, count, sum) make a grouped search.",
  writes: false,
  input: z.object({ ...searchShape, limit: z.number().int().min(1).max(50).default(20) }),
  async handler({ limit, ...spec }, { ns }) {
    const res = await preview(ns, spec, limit);
    return { recordType: res.recordType, totalCount: res.totalCount, columns: res.columns, rows: res.rows, rowCount: res.rows.length };
  },
});

export const nsSearchSave = defineTool({
  name: "ns_search_save",
  title: "Save a saved search",
  description:
    "Saves a private saved search with id customsearch_nsagent_<scriptIdSuffix>. This writes to NetSuite: the first " +
    "call returns approval_pending with a preview and saves nothing; after a human approves, call again with the " +
    "same arguments plus approvalId. Preview with ns_search_preview first.",
  writes: true,
  input: z.object({
    ...searchShape,
    title: z.string().min(3).max(100),
    scriptIdSuffix: z
      .string()
      .regex(/^[a-z0-9_]{3,30}$/, "scriptIdSuffix must be 3-30 lowercase letters, digits or _ (ns-conventions)"),
  }),
  async describeChange({ title, scriptIdSuffix, ...spec }, { ns }) {
    const { totalCount } = await preview(ns, spec, 1);
    return [
      `Save private saved search "${title}" as customsearch_nsagent_${scriptIdSuffix} on ${spec.recordType}.`,
      `Filters: ${spec.filters.length ? spec.filters.map(describeFilter).join(" AND ") : "none"}.`,
      `Columns: ${spec.columns.map(describeColumn).join(", ")}.`,
      `It currently matches ${totalCount} results.`,
    ].join(" ");
  },
  async handler({ title, scriptIdSuffix, ...spec }, { ns }) {
    return callRestlet(ns, {
      ...SEARCH_RESTLET,
      body: { action: "save", ...spec, title, scriptId: `customsearch_nsagent_${scriptIdSuffix}` },
    });
  },
});

export const searchBuilderTools = [nsSearchPreview, nsSearchSave] as unknown as ToolDef[];
