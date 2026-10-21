import { createHash } from "node:crypto";
import { realpath, stat, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRecord, describeRecordSchema } from "@ns-agent/ns-client";
import {
  MappingError,
  classifyFields,
  dryRun,
  existingKeys,
  parseCsv,
  recordBody,
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
  const bytes = await readFile(file);
  try {
    parsed = parseCsv(bytes.toString("utf8"));
  } catch (error) {
    throw new ToolInputError(`${name}: ${(error as Error).message}`);
  }
  if (parsed.headers.length > MAX_COLUMNS) throw new ToolInputError(`${name} has more than ${MAX_COLUMNS} columns`);
  if (parsed.rows.length > MAX_ROWS) throw new ToolInputError(`${name} has more than ${MAX_ROWS} rows; split it`);
  return { file: path.relative(root, file), sha256: createHash("sha256").update(bytes).digest("hex"), ...parsed };
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

interface ImportArgs {
  file: string;
  recordType: string;
  mapping: Record<string, string>;
  keyField?: string;
}

/** Reads the file and checks every row (read-only). Shared by the dry run and the import run. */
async function analyse(ctx: ToolContext, { file, recordType: type, mapping, keyField }: ImportArgs) {
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
  try {
    const result = dryRun({ recordType: type, headers: csv.headers, rows: csv.rows, mapping, fields, references, keyField, existingKeys: existing });
    return { csv, fields, references, result, duplicateCheck };
  } catch (error) {
    if (error instanceof MappingError) throw new ToolInputError(error.message);
    throw error;
  }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

async function writeCsv(name: string, keys: string[], rows: Array<Record<string, string>>): Promise<string> {
  await mkdir(exportDir(), { recursive: true });
  const file = path.join(exportDir(), name);
  await writeFile(file, toCsv(keys.map((key) => ({ key, label: key, type: "text" as const })), rows));
  return file;
}

const importArgs = {
  file: fileName,
  recordType,
  mapping: z.record(z.string(), z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)).describe("CSV header -> record field id"),
  keyField: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).optional().describe("Field that identifies a record, e.g. externalId"),
};

export const nsImportDryRun = defineTool({
  name: "ns_import_dry_run",
  title: "Dry-run a CSV import",
  description:
    "Checks every row of a CSV against a column-to-field mapping: required fields, types and formats, references " +
    "(subsidiary, currency, department, location, sales rep) and duplicates by keyField, in the file and in " +
    "NetSuite. Writes an error file and returns counts, the first 20 errors and the file's sha256 (needed by " +
    "ns_import_run). Changes nothing in NetSuite.",
  writes: false,
  input: z.object(importArgs),
  async handler(args, ctx) {
    const { csv, result, duplicateCheck } = await analyse(ctx, args);
    // Error file: values are redacted per field, like every other output.
    const rows = result.errors.map((e) => ({
      line: String(e.line),
      column: e.column,
      field: e.field,
      check: e.check,
      message: e.message,
      value: String(ctx.redact({ [e.field]: e.value })[e.field] ?? ""),
    }));
    const errorFile = rows.length
      ? await writeCsv(`${path.basename(csv.file, ".csv")}-dry-run-errors-${stamp()}.csv`, ["line", "column", "field", "check", "message", "value"], rows)
      : null;
    return {
      file: csv.file,
      fileSha256: csv.sha256,
      recordType: args.recordType,
      rowCount: result.rowCount,
      validRows: result.validRows,
      invalidRows: result.invalidRows,
      errorsByCheck: result.errorsByCheck,
      errors: rows.slice(0, ERRORS_TO_MODEL),
      errorFile,
      unverifiedReferences: result.unverifiedReferences,
      duplicateCheck,
      note:
        result.invalidRows === 0
          ? "Dry run only: nothing was written. Every row is valid; ns_import_run can load it after approval."
          : "Dry run only: nothing was written. Fix the errors and dry-run again before ns_import_run.",
    };
  },
});

/** Record types ns_import_run may create (ADR 0005). Each needs Create permission on the integration role. */
export const IMPORT_RECORD_TYPES = new Set(["customer"]);
const MAX_RUN_ROWS = 500;
const MAX_CONSECUTIVE_FAILURES = 5;

const runArgs = z.object({
  ...importArgs,
  fileSha256: z.string().regex(/^[0-9a-f]{64}$/, "the fileSha256 returned by ns_import_dry_run"),
});

async function readyToLoad(ctx: ToolContext, args: z.infer<typeof runArgs>) {
  if (!IMPORT_RECORD_TYPES.has(args.recordType)) {
    throw new ToolInputError(`importing ${args.recordType} records is not enabled; allowed: ${[...IMPORT_RECORD_TYPES].join(", ")}`);
  }
  const analysis = await analyse(ctx, args);
  if (analysis.csv.sha256 !== args.fileSha256) {
    throw new ToolInputError(`${args.file} changed since it was dry-run (sha256 differs); dry-run it again. No change was made.`);
  }
  if (analysis.result.rowCount === 0) throw new ToolInputError(`${args.file} has no rows`);
  if (analysis.result.rowCount > MAX_RUN_ROWS) {
    throw new ToolInputError(`${args.file} has ${analysis.result.rowCount} rows; split it into files of at most ${MAX_RUN_ROWS}`);
  }
  if (analysis.result.invalidRows > 0) {
    throw new ToolInputError(
      `${analysis.result.invalidRows} of ${analysis.result.rowCount} rows fail the dry run now; run ns_import_dry_run and fix them. No change was made.`,
    );
  }
  // Build every body before writing anything, so a conversion problem stops the run with nothing created.
  const bodies = analysis.csv.rows.map((row) => {
    try {
      return recordBody(analysis.csv.headers, row, args.mapping, analysis.fields, analysis.references);
    } catch (error) {
      if (error instanceof MappingError) throw new ToolInputError(`${error.message}. No change was made.`);
      throw error;
    }
  });
  return { ...analysis, bodies };
}

export const nsImportRun = defineTool({
  name: "ns_import_run",
  title: "Load a validated CSV",
  description:
    "Creates one record per row of a CSV that passed ns_import_dry_run (all rows valid). This writes to NetSuite: " +
    "the first call returns approval_pending with a preview and creates nothing; after a human approves, call again " +
    "with the same arguments plus approvalId. Pass the fileSha256 from the dry run; an edited file is refused. " +
    `Create only, at most ${MAX_RUN_ROWS} rows, record types: ${[...IMPORT_RECORD_TYPES].join(", ")}.`,
  writes: true,
  approvalTtlMinutes: 30,
  input: runArgs,
  async describeChange(args, ctx) {
    const { csv, bodies } = await readyToLoad(ctx, args);
    const fieldsUsed = [...new Set(Object.values(args.mapping))].join(", ");
    return [
      `Create ${bodies.length} new ${args.recordType} records from ${csv.file} (sha256 ${args.fileSha256.slice(0, 12)}).`,
      `Fields: ${fieldsUsed}.`,
      args.keyField ? `No ${args.keyField} in the file exists in NetSuite yet.` : "No key field was given, so duplicates of existing records were not checked.",
      "Every row passed the dry run. Nothing is updated or deleted.",
    ].join(" ");
  },
  async handler(args, ctx) {
    // Checked again now: records may have been created since the approval.
    const { csv, bodies } = await readyToLoad(ctx, args);
    const results: Array<Record<string, string>> = csv.rows.map((_, i) => ({ line: String(i + 2), status: "not attempted", internalId: "", error: "" }));
    let created = 0;
    let failed = 0;
    let consecutive = 0;
    for (let i = 0; i < bodies.length; i++) {
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) break;
      try {
        const { id } = await createRecord(ctx.ns, args.recordType, bodies[i]!);
        results[i] = { line: String(i + 2), status: "created", internalId: id, error: "" };
        created++;
        consecutive = 0;
      } catch (error) {
        results[i] = { line: String(i + 2), status: "failed", internalId: "", error: (error as Error).message.slice(0, 300) };
        failed++;
        consecutive++;
      }
    }
    const resultFile = await writeCsv(`${path.basename(csv.file, ".csv")}-import-results-${stamp()}.csv`, ["line", "status", "internalId", "error"], results);
    const notAttempted = results.filter((r) => r.status === "not attempted").length;
    return {
      file: csv.file,
      recordType: args.recordType,
      rowCount: bodies.length,
      created,
      failed,
      notAttempted,
      stoppedEarly: notAttempted > 0,
      resultFile,
      failures: results.filter((r) => r.status === "failed").slice(0, ERRORS_TO_MODEL),
      createdIds: results.filter((r) => r.status === "created").slice(0, ERRORS_TO_MODEL).map((r) => r.internalId),
    };
  },
});

export const dataImporterTools = [nsImportPlan, nsImportDryRun, nsImportRun] as unknown as ToolDef[];
