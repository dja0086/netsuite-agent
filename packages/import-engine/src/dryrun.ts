import { requiredFields, type FieldKind, type ImportField } from "./fields";

export type Check = "required" | "type" | "format" | "reference" | "duplicate-in-file" | "exists-in-netsuite";

export interface RowError {
  /** Line in the file (the header is line 1). */
  line: number;
  column: string;
  field: string;
  check: Check;
  message: string;
  value: string;
}

export interface ReferenceIndex {
  /** False when the target list could not be read; values are then not checked and the field is reported. */
  verified: boolean;
  /** Lower-cased internal id, name or symbol -> internal id, or "ambiguous". */
  values: Map<string, string>;
}

export interface DryRunInput {
  recordType: string;
  headers: string[];
  rows: string[][];
  /** CSV header -> record field id. Unmapped columns are ignored. */
  mapping: Record<string, string>;
  fields: ImportField[];
  references: Map<string, ReferenceIndex>;
  /** Field used to find duplicates in the file and records that already exist. */
  keyField?: string;
  /** Values of keyField that already exist in NetSuite. */
  existingKeys?: Set<string>;
}

export interface DryRunResult {
  rowCount: number;
  validRows: number;
  invalidRows: number;
  errorsByCheck: Partial<Record<Check, number>>;
  errors: RowError[];
  unverifiedReferences: string[];
  requiredFields: string[];
}

export class MappingError extends Error {
  override readonly name = "MappingError";
}

const TRUE = new Set(["t", "true", "yes", "y", "1"]);
const FALSE = new Set(["f", "false", "no", "n", "0"]);

function typeProblem(kind: FieldKind, v: string): { check: Check; message: string } | undefined {
  switch (kind) {
    case "number":
      return /^-?\d+(\.\d+)?$/.test(v) ? undefined : { check: "type", message: "must be a plain number such as 1250.50 (no thousands separators)" };
    case "integer":
      return /^-?\d+$/.test(v) ? undefined : { check: "type", message: "must be a whole number" };
    case "boolean":
      return TRUE.has(v.toLowerCase()) || FALSE.has(v.toLowerCase()) ? undefined : { check: "type", message: "must be true/false (T/F, yes/no, 1/0)" };
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { check: "type", message: "must be a date as YYYY-MM-DD" };
      const d = new Date(`${v}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? undefined : { check: "type", message: `${v} is not a real date` };
    }
    case "datetime":
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(v) && !Number.isNaN(Date.parse(v))
        ? undefined
        : { check: "type", message: "must be an ISO date-time such as 2026-10-21T09:30:00Z" };
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? undefined : { check: "format", message: "is not an email address" };
    case "string":
      return v.length <= 4000 ? undefined : { check: "type", message: "is longer than 4000 characters" };
    default:
      return undefined;
  }
}

/** Checks every row without contacting NetSuite; reference and duplicate lookups are passed in. Writes nothing. */
export function dryRun(input: DryRunInput): DryRunResult {
  const byId = new Map(input.fields.map((f) => [f.id, f]));
  const columnIndex = new Map(input.headers.map((h, i) => [h, i]));
  const targets = new Set<string>();
  for (const [header, fieldId] of Object.entries(input.mapping)) {
    if (!columnIndex.has(header)) throw new MappingError(`column "${header}" is not in the file`);
    if (!byId.has(fieldId)) {
      throw new MappingError(`${fieldId} is not a ${input.recordType} field that can be imported (see ns_import_plan for the fields)`);
    }
    if (targets.has(fieldId)) throw new MappingError(`${fieldId} is mapped twice`);
    targets.add(fieldId);
  }
  if (input.keyField && !targets.has(input.keyField)) throw new MappingError(`keyField ${input.keyField} is not mapped`);

  const mapped = input.headers.filter((h) => h in input.mapping).map((h) => ({ header: h, index: columnIndex.get(h)!, field: byId.get(input.mapping[h]!)! }));
  const isPersonCol = mapped.find((m) => m.field.id === "isPerson");
  const errors: RowError[] = [];
  const seenKeys = new Map<string, number>();
  const unverified = new Set<string>();
  let invalidRows = 0;

  input.rows.forEach((row, r) => {
    const line = r + 2;
    const before = errors.length;
    const isPerson = isPersonCol ? TRUE.has((row[isPersonCol.index] ?? "").trim().toLowerCase()) : false;
    const required = new Set(requiredFields(input.recordType, isPerson));

    for (const m of mapped) {
      const value = (row[m.index] ?? "").trim();
      const err = (check: Check, message: string) => errors.push({ line, column: m.header, field: m.field.id, check, message, value });
      if (value === "") {
        if (required.has(m.field.id)) err("required", `${m.field.label} is required`);
        continue;
      }
      if (m.field.kind === "reference") {
        const index = input.references.get(m.field.id);
        if (!index || !index.verified) {
          unverified.add(m.field.id);
        } else {
          const id = index.values.get(value.toLowerCase());
          if (!id) err("reference", `"${value}" does not match any ${m.field.label} by internal id or name`);
          else if (id === "ambiguous") err("reference", `"${value}" matches more than one ${m.field.label}; use the internal id`);
        }
      } else {
        const problem = typeProblem(m.field.kind, value);
        if (problem) err(problem.check, `${m.field.label} ${problem.message}`);
      }
      if (input.keyField === m.field.id) {
        const first = seenKeys.get(value);
        if (first !== undefined) err("duplicate-in-file", `${m.field.label} "${value}" repeats line ${first}`);
        else {
          seenKeys.set(value, line);
          if (input.existingKeys?.has(value)) err("exists-in-netsuite", `a ${input.recordType} with ${m.field.label} "${value}" already exists`);
        }
      }
    }
    // Required fields that are not mapped at all fail every row.
    for (const req of required) {
      if (!targets.has(req)) errors.push({ line, column: "", field: req, check: "required", message: `${byId.get(req)?.label ?? req} is required but no column is mapped to it`, value: "" });
    }
    if (errors.length > before) invalidRows++;
  });

  const errorsByCheck: Partial<Record<Check, number>> = {};
  for (const e of errors) errorsByCheck[e.check] = (errorsByCheck[e.check] ?? 0) + 1;
  return {
    rowCount: input.rows.length,
    validRows: input.rows.length - invalidRows,
    invalidRows,
    errorsByCheck,
    errors,
    unverifiedReferences: [...unverified].sort(),
    requiredFields: [...new Set(input.rows.length ? requiredFields(input.recordType, false) : [])],
  };
}
