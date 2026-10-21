import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collect, suiteqlOffset } from "@ns-agent/ns-client";
import {
  ReportParamError,
  loadDefinitions,
  runReport,
  toCsv,
  toXlsx,
  type ReportColumn,
  type ReportDefinition,
  type ReportRow,
} from "@ns-agent/report-engine";
import { assertSelectOnly } from "@ns-agent/suiteql";
import { z } from "zod";
import { ToolInputError, defineTool, type ToolContext, type ToolDef } from "../registry";

const here = path.dirname(fileURLToPath(import.meta.url));
const definitionsDir = () => process.env.NS_AGENT_REPORTS_DIR?.trim() || path.resolve(here, "../../../../skills/reports/definitions");
const exportDir = () => process.env.NS_AGENT_EXPORT_DIR?.trim() || path.resolve("exports");

let cache: Promise<ReportDefinition[]> | undefined;
/** Definitions change only by pull request, so they are read once per gateway process. */
export function reportDefinitions(): Promise<ReportDefinition[]> {
  cache ??= loadDefinitions(definitionsDir());
  return cache;
}

const SAMPLE_ROWS = 10;
const format = z.enum(["csv", "xlsx"]).default("xlsx");

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "export";

/** Writes the export (redacted) and returns what the model sees: the path, counts and a short sample. */
async function writeExport(
  ctx: ToolContext,
  name: string,
  title: string,
  fmt: "csv" | "xlsx",
  columns: ReportColumn[],
  allRows: ReportRow[],
  truncated: boolean,
) {
  const rows = ctx.redact(allRows);
  const dir = exportDir();
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const file = path.join(dir, `${slug(name)}-${stamp}.${fmt}`);
  await writeFile(file, fmt === "csv" ? toCsv(columns, rows) : toXlsx(title, columns, rows));
  return {
    file,
    format: fmt,
    rowCount: rows.length,
    truncated,
    columns: columns.map((c) => c.label),
    sample: rows.slice(0, SAMPLE_ROWS),
  };
}

export const nsReportList = defineTool({
  name: "ns_report_list",
  title: "List report definitions",
  description: "Lists the reviewed report definitions: id, title, what each shows, its parameters and its columns.",
  writes: false,
  input: z.object({}),
  async handler() {
    const defs = await reportDefinitions();
    return {
      count: defs.length,
      reports: defs.map((d) => ({
        id: d.id,
        title: d.title,
        description: d.description,
        params: d.params.map((p) => ({ name: p.name, type: p.type, required: p.required, default: p.default, description: p.description })),
        columns: d.columns.map((c) => c.label),
      })),
    };
  },
});

export const nsReportRun = defineTool({
  name: "ns_report_run",
  title: "Run a report to a file",
  description:
    "Runs a report definition (see ns_report_list) and writes every row to a CSV or XLSX file on the gateway host. " +
    "Returns the file path, row count, whether it was truncated, and the first 10 rows. Read-only in NetSuite.",
  writes: false,
  input: z.object({
    reportId: z.string().min(1).max(41),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())])).default({}),
    format,
    maxRows: z.number().int().min(1).max(100_000).optional(),
  }),
  async handler({ reportId, params, format: fmt, maxRows }, ctx) {
    const def = (await reportDefinitions()).find((d) => d.id === reportId);
    if (!def) throw new ToolInputError(`unknown report ${reportId}; call ns_report_list for the available ids`);
    try {
      const result = await runReport(ctx.ns, def, params, { maxRows });
      return writeExport(ctx, def.id, def.title, fmt, def.columns, result.rows, result.truncated);
    } catch (error) {
      if (error instanceof ReportParamError) throw new ToolInputError(error.message);
      throw error;
    }
  },
});

export const nsReportExportQuery = defineTool({
  name: "ns_report_export_query",
  title: "Export a SuiteQL query to a file",
  description:
    "Runs one SuiteQL SELECT and writes every row (up to maxRows) to a CSV or XLSX file. Use for one-off exports " +
    "that have no report definition. Columns default to the query's aliases as text; pass columns to type numbers and dates.",
  writes: false,
  input: z.object({
    q: z.string().min(8).max(20_000),
    title: z.string().min(3).max(80),
    format,
    maxRows: z.number().int().min(1).max(100_000).default(50_000),
    columns: z
      .array(
        z.object({
          key: z.string().regex(/^[a-z][a-z0-9_]*$/),
          label: z.string().min(1).max(60),
          type: z.enum(["text", "integer", "number", "currency", "date"]).default("text"),
        }),
      )
      .max(100)
      .optional(),
  }),
  async handler({ q, title, format: fmt, maxRows, columns }, ctx) {
    const query = assertSelectOnly(q);
    const rows = await collect(suiteqlOffset<ReportRow>(ctx.ns, query), maxRows + 1);
    const truncated = rows.length > maxRows;
    const kept = truncated ? rows.slice(0, maxRows) : rows;
    const cols: ReportColumn[] = columns ?? Object.keys(kept[0] ?? {}).map((key) => ({ key, label: key, type: "text" }));
    if (cols.length === 0) cols.push({ key: "result", label: "result", type: "text" });
    return writeExport(ctx, title, title, fmt, cols, kept, truncated);
  },
});

export const reportsTools = [nsReportList, nsReportRun, nsReportExportQuery] as unknown as ToolDef[];
