export type FieldKind = "string" | "email" | "number" | "integer" | "boolean" | "date" | "datetime" | "reference";

export interface ImportField {
  id: string;
  label: string;
  kind: FieldKind;
  custom: boolean;
}

interface SchemaProp {
  title?: string;
  type?: string | string[];
  format?: string;
  readOnly?: boolean;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Body fields a CSV column can fill, from a REST record JSON Schema. Drops read-only fields, the internal id,
 * and sublists (objects holding `items`). Reference fields are objects with `id` and `refName`.
 */
export function classifyFields(schema: Record<string, unknown>): ImportField[] {
  const props = (schema.properties ?? {}) as Record<string, SchemaProp>;
  const out: ImportField[] = [];
  for (const [id, p] of Object.entries(props)) {
    if (p.readOnly || id === "id" || id === "links" || id === "refName") continue;
    const type = Array.isArray(p.type) ? p.type[0] : p.type;
    let kind: FieldKind | undefined;
    if (type === "object") {
      const inner = p.properties ?? {};
      if ("id" in inner && "refName" in inner && !("items" in inner)) kind = "reference";
    } else if (type === "boolean") kind = "boolean";
    else if (type === "integer") kind = "integer";
    else if (type === "number") kind = "number";
    else if (type === "string") {
      kind = p.format === "date" ? "date" : p.format === "date-time" ? "datetime" : /email/i.test(id) ? "email" : "string";
    }
    if (!kind) continue;
    out.push({ id, label: (p.title ?? id).trim(), kind, custom: /^cust/.test(id) || p["x-ns-custom-field"] === true });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface ColumnMatch {
  header: string;
  field: string | null;
  label?: string;
  kind?: FieldKind;
  /** id: the header is the field id; label: it is the field label; none: no match. */
  match: "id" | "label" | "none";
}

/** Proposes a field per header: exact or normalised id first, then label. Each field is used at most once. */
export function suggestMapping(headers: string[], fields: ImportField[]): ColumnMatch[] {
  const used = new Set<string>();
  return headers.map((header) => {
    const n = norm(header);
    const byId = fields.find((f) => !used.has(f.id) && norm(f.id) === n);
    const byLabel = byId ? undefined : fields.find((f) => !used.has(f.id) && norm(f.label) === n);
    const f = byId ?? byLabel;
    if (!f) return { header, field: null, match: "none" as const };
    used.add(f.id);
    return { header, field: f.id, label: f.label, kind: f.kind, match: byId ? ("id" as const) : ("label" as const) };
  });
}

/**
 * Fields NetSuite always needs for common record types (OneWorld: subsidiary). Forms and customisations can
 * require more; the dry run says this list is not exhaustive.
 */
export function requiredFields(recordType: string, isPerson: boolean): string[] {
  switch (recordType.toLowerCase()) {
    case "customer":
      return isPerson ? ["firstName", "lastName", "subsidiary"] : ["companyName", "subsidiary"];
    case "vendor":
      return isPerson ? ["firstName", "lastName", "subsidiary"] : ["companyName", "subsidiary"];
    case "contact":
      return ["firstName", "lastName"];
    default:
      return [];
  }
}
