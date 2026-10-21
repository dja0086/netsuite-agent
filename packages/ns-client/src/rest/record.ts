import type { NsRequester } from "../http";
import { stripLinks } from "../strip-links";

const RECORD_TYPE = /^[A-Za-z][A-Za-z0-9_]*$/;
const RECORD_ID = /^(\d+|eid:[^/?#\s]+)$/;

export function assertRecordType(type: string): string {
  if (!RECORD_TYPE.test(type)) throw new Error(`Invalid record type: ${type}`);
  return type;
}

export function assertRecordId(id: string): string {
  if (!RECORD_ID.test(id)) throw new Error(`Invalid record id: ${id} (use an internal id or eid:<external id>)`);
  return id;
}

/** Reads one record through the REST Record API. */
export async function getRecord(
  ns: NsRequester,
  type: string,
  id: string,
  options: { fields?: string[]; expandSubResources?: boolean } = {},
): Promise<Record<string, unknown>> {
  const fields = options.fields?.map((f) => {
    if (!RECORD_TYPE.test(f)) throw new Error(`Invalid field id: ${f}`);
    return f;
  });
  const record = await ns.request<Record<string, unknown>>({
    method: "GET",
    base: "rest",
    path: `/services/rest/record/v1/${assertRecordType(type)}/${encodeURIComponent(assertRecordId(id)).replace("%3A", ":")}`,
    query: {
      fields: fields?.length ? fields.join(",") : undefined,
      expandSubResources: options.expandSubResources ? "true" : undefined,
    },
  });
  const result = stripLinks(record);
  // With `fields`, NetSuite omits the id from the response; put back the internal id we asked for.
  if (result.id === undefined && /^\d+$/.test(id)) return { id, ...result };
  return result;
}

/** Lists record types exposed to the integration role through the REST metadata catalog. */
export async function listRecordTypes(ns: NsRequester): Promise<string[]> {
  const catalog = await ns.request<{ items?: Array<{ name?: string }> }>({
    method: "GET",
    base: "rest",
    path: "/services/rest/record/v1/metadata-catalog",
  });
  return (catalog.items ?? []).map((i) => i.name).filter((n): n is string => typeof n === "string").sort();
}

export interface FieldSummary {
  id: string;
  label: string;
  type: string;
  nullable: boolean;
  custom: boolean;
  /** Target record type for list/record (select) fields, when the schema states it. */
  references?: string;
}

interface JsonSchemaProperty {
  title?: string;
  type?: string | string[];
  format?: string;
  nullable?: boolean;
  $ref?: string;
  [key: string]: unknown;
}

/** Fetches the JSON Schema for one record type. */
export async function describeRecordSchema(ns: NsRequester, type: string): Promise<Record<string, unknown>> {
  return ns.request<Record<string, unknown>>({
    method: "GET",
    base: "rest",
    path: `/services/rest/record/v1/metadata-catalog/${assertRecordType(type)}`,
    headers: { Accept: "application/schema+json" },
  });
}

/** Flattens a record JSON Schema into a compact field list the model can read cheaply. */
export function summarizeSchema(schema: Record<string, unknown>): FieldSummary[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchemaProperty>;
  return Object.entries(properties)
    .map(([id, prop]) => {
      const rawType = Array.isArray(prop.type) ? prop.type.join("|") : (prop.type ?? (prop.$ref ? "object" : "unknown"));
      const ref = typeof prop["x-ns-recordType"] === "string" ? (prop["x-ns-recordType"] as string) : undefined;
      const summary: FieldSummary = {
        id,
        label: prop.title ?? id,
        type: prop.format ? `${rawType}:${prop.format}` : rawType,
        nullable: Boolean(prop.nullable),
        custom: /^cust/.test(id),
      };
      if (ref) summary.references = ref;
      return summary;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Caches metadata per record type; schemas change only when someone deploys customizations. */
export class MetadataCache {
  private readonly entries = new Map<string, { value: FieldSummary[]; at: number }>();
  private typeList: { value: string[]; at: number } | undefined;

  constructor(
    private readonly ns: NsRequester,
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  async recordTypes(): Promise<string[]> {
    if (this.typeList && this.now() - this.typeList.at < this.ttlMs) return this.typeList.value;
    const value = await listRecordTypes(this.ns);
    this.typeList = { value, at: this.now() };
    return value;
  }

  async fields(type: string): Promise<FieldSummary[]> {
    const key = assertRecordType(type).toLowerCase();
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const value = summarizeSchema(await describeRecordSchema(this.ns, type));
    this.entries.set(key, { value, at: this.now() });
    return value;
  }

  clear(): void {
    this.entries.clear();
    this.typeList = undefined;
  }
}
