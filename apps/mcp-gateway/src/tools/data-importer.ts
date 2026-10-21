import { realpath, stat, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describeRecordSchema } from "@ns-agent/ns-client";
import {
  MappingError,
  classifyFields,
  dryRun,
  existingKeys,
  parseCsv,
  referenceIndex,
  requiredFields,
  suggestMapping,
  type ImportField,
  type ReferenceIndex,
} from "@ns-agent/import-engine";
import { toCsv } from "@ns-agent/report-engine";
import { z } from "zod";
import { ToolInputError, defineTool, type ToolContext, type ToolDef } from "../registry";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 25_000;
const MAX_COLUMNS = 200;
const ERRORS_TO_MODEL = 20;

const importDir = () => process.env.NS_AGENT_IMPORT_DIR?.trim() || path.resolve("imports");
const exportDir = () => process.env.NS_AGENT_EXPORT_DIR?.trim() || path.resolve("exports");

/**
 * Resolves a file name inside the import folder. Symlinks and ../ are resolved first, so nothing outside
 * the folder (.env, keys, other files on the host) can ever be read.
 */
async function readImportFile(name: string) {
  let root: string;
  let file: string;
  try {
    root = await realpath(importDir());
  } catch {
    throw new ToolInputError(`the import folder ${importDir()} does not exist; put the CSV there (NS_AGENT_IMPORT_DIR)`);
  }
  // Containment first: a name that points outside the folder is refused whatever its extension.
  if (path.isAbsolute(name) || !path.resolve(root, name).startsWith(root + path.sep)) {
    throw new ToolInputError("the file must be inside the import folder (NS_AGENT_IMPORT_DIR)");
  }
  if (!/\.csv$/i.test(name)) throw new ToolInputError("only .csv files can be read");
  try {
    file = await realpath(path.resolve(root, name));
  } catch {
    if (!path.resolve(root, name).startsWith(root + path.sep)) throw new ToolInputError("the file must be inside the import folder (NS_AGENT_IMPORT_DIR)");
    throw new ToolInputError(`${name} was not found in the import folder`);
  }
  if (!file.startsWith(root + path.sep)) throw new ToolInputError("the file must be inside the import folder (NS_AGENT_IMPORT_DIR)");
  const info = await stat(file);
  if (!info.isFile()) throw new ToolInputError(`${name} is not a file`);
  if (info.size > MAX_BYTES) throw new ToolInputError(`${name} is larger than 10 MB; split it`);
  let parsed;
  try {
    parsed = parseCsv(await readFile(file, "utf8"));
  } catch (error) {
    throw new ToolInputError(`${name}: ${(error as Error).message}`);
  }
  if (parsed.headers.length > MAX_COLUMNS) throw new ToolInputError(`${name} has more than ${MAX_COLUMNS} columns`);
  if (parsed.rows.length > MAX_ROWS) throw new ToolInputError(`${name} has more than ${MAX_ROWS} rows; split it`);
  return { file: path.relative(root, file), ...parsed };
}

const recordType = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, "a record type id such as customer, vendor or contact");
const fileName = z.string().min(5).max(200).describe("CSV file name inside the import folder (NS_AGENT_IMPORT_DIR, default ./imports)");

async function fieldsFor(ctx: ToolContext, type: string): Promise<ImportField[]> {
  return classifyFields(await describeRecordSchema(ctx.ns, type));
}

export const nsImportPlan = defineTool({
  name: "ns_import_plan",
  title: "Plan a CSV import",
  description:
    "Reads a CSV from the import folder and proposes which record field each column fills, from the record's " +
    "metadata. Lists unmapped columns, the fields NetSuite needs, and a 3-row sample. Writes nothing.",
  writes: false,
  input: z.object({ file: fileName, recordType }),
  async handler({ file, recordType: type }, ctx) {
    const csv = await readImportFile(file);
    const fields = await fieldsFor(ctx, type);
    const columns = suggestMapping(csv.headers, fields);
    const mappedFields = new Set(columns.map((c) => c.field).filter(Boolean));
    const required = requiredFields(type, false);
    const sample = csv.rows.slice(0, 3).map((row) =>
      Object.fromEntries(columns.map((c, i) => [c.field ?? c.header, row[i] ?? ""])),
    );
    return {
      file: csv.file,
      recordType: type,
      rowCount: csv.rows.length,
      columns,
      unmappedHeaders: columns.filter((c) => !c.field).map((c) => c.header),
      requiredFields: required,
      missingRequired: required.filter((f) => !mappedFields.has(f)),
      importableFieldCount: fields.length,
      sample: ctx.redact(sample),
      note: "Required fields are the ones NetSuite always needs; forms and customisations can require more.",
    };
  },
});

export const nsImportDryRun = defineTool({
  name: "ns_import_dry_run",
  title: "Dry-run a CSV import",
  description:
    "Checks every row of a CSV against a column-to-field mapping: required fields, types and formats, references " +
    "(subsidiary, currency, department, location, sales rep) and duplicates by keyField, in the file and in " +
    "NetSuite. Writes an error file and returns counts and the first 20 errors. Changes nothing in NetSuite.",
  writes: false,
  input: z.object({
    file: fileName,
    recordType,
    mapping: z.record(z.string(), z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)).describe("CSV header -> record field id"),
    keyField: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).optional().describe("Field that identifies a record, e.g. externalId"),
  }),
  async handler({ file, recordType: type, mapping, keyField }, ctx) {
    const csv = await readImportFile(file);
    const fields = await fieldsFor(ctx, type);
    const byId = new Map(fields.map((f) => [f.id, f]));
    for (const fieldId of Object.values(mapping)) {
      if (!byId.has(fieldId)) throw new ToolInputError(`${fieldId} is not a ${type} field that can be imported (see ns_import_plan)`);
    }
    const column = (header: string) => csv.headers.indexOf(header);
    const references = new Map<string, ReferenceIndex>();
    for (const [header, fieldId] of Object.entries(mapping)) {
      if (byId.get(fieldId)?.kind === "reference" && column(header) >= 0) {
        references.set(fieldId, await referenceIndex(ctx.ns, fieldId, csv.rows.map((r) => r[column(header)] ?? "")));
      }
    }
    let existing: Set<string> | undefined;
    let duplicateCheck = "not requested";
    if (keyField) {
      const header = Object.entries(mapping).find(([, f]) => f === keyField)?.[0];
      if (header && column(header) >= 0) {
        existing = await existingKeys(ctx.ns, type, keyField, csv.rows.map((r) => r[column(header)] ?? ""));
        duplicateCheck = existing ? "checked against NetSuite" : "could not query NetSuite for this field; checked within the file only";
      }
    }

    let result;
    try {
      result = dryRun({ recordType: type, headers: csv.headers, rows: csv.rows, mapping, fields, references, keyField, existingKeys: existing });
    } catch (error) {
      if (error instanceof MappingError) throw new ToolInputError(error.message);
      throw error;
    }

    // Error file: values are redacted per field, like every other output.
    const rows = result.errors.map((e) => ({
      line: String(e.line),
      column: e.column,
      field: e.field,
      check: e.check,
      message: e.message,
      value: String(ctx.redact({ [e.field]: e.value })[e.field] ?? ""),
    }));
    let errorFile: string | null = null;
    if (rows.length) {
      await mkdir(exportDir(), { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
      errorFile = path.join(exportDir(), `${path.basename(csv.file, ".csv")}-dry-run-errors-${stamp}.csv`);
      const cols = ["line", "column", "field", "check", "message", "value"].map((key) => ({ key, label: key, type: "text" as const }));
      await writeFile(errorFile, toCsv(cols, rows));
    }
    return {
      file: csv.file,
      recordType: type,
      rowCount: result.rowCount,
      validRows: result.validRows,
      invalidRows: result.invalidRows,
      errorsByCheck: result.errorsByCheck,
      errors: rows.slice(0, ERRORS_TO_MODEL),
      errorFile,
      unverifiedReferences: result.unverifiedReferences,
      duplicateCheck,
      note: "Dry run only: nothing was written to NetSuite. Loading rows is not available until CP3.",
    };
  },
});

export const dataImporterTools = [nsImportPlan, nsImportDryRun] as unknown as ToolDef[];
