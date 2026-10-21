import { NsHttpError, collect, suiteqlOffset, type NsRequester } from "@ns-agent/ns-client";
import { literal } from "@ns-agent/suiteql";
import type { ReferenceIndex } from "./dryrun";

/** SuiteQL lists that reference fields point to, and the columns a CSV value may match. */
export const REFERENCE_TABLES: Record<string, { table: string; match: string[] }> = {
  subsidiary: { table: "subsidiary", match: ["name"] },
  currency: { table: "currency", match: ["name", "symbol"] },
  department: { table: "department", match: ["name"] },
  location: { table: "location", match: ["name"] },
  salesRep: { table: "employee", match: ["entityid"] },
};

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * Builds a lookup for one reference field from the values in the file (read-only SuiteQL). Fields without a
 * known list, or lists the role cannot read, come back unverified rather than failing the dry run.
 */
export async function referenceIndex(ns: NsRequester, field: string, values: string[]): Promise<ReferenceIndex> {
  const spec = REFERENCE_TABLES[field];
  if (!spec) return { verified: false, values: new Map() };
  const distinct = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  const index = new Map<string, string>();
  const add = (key: string, id: string) => {
    const k = key.toLowerCase();
    const prev = index.get(k);
    index.set(k, prev && prev !== id ? "ambiguous" : id);
  };
  try {
    for (const part of chunks(distinct, 200)) {
      const ids = part.filter((v) => /^\d{1,12}$/.test(v));
      const names = part.map((v) => literal(v.toUpperCase())).join(", ");
      const where = [ids.length ? `t.id IN (${ids.join(", ")})` : "", ...spec.match.map((c) => `UPPER(t.${c}) IN (${names})`)].filter(Boolean).join(" OR ");
      const cols = ["t.id AS id", ...spec.match.map((c) => `t.${c} AS ${c}`)].join(", ");
      const rows = await collect(suiteqlOffset<Record<string, unknown>>(ns, `SELECT ${cols} FROM ${spec.table} t WHERE ${where}`));
      for (const row of rows) {
        const id = String(row.id);
        add(id, id);
        for (const c of spec.match) if (typeof row[c] === "string" && row[c]) add(row[c] as string, id);
      }
    }
    return { verified: true, values: index };
  } catch (error) {
    if (error instanceof NsHttpError) return { verified: false, values: new Map() };
    throw error;
  }
}

/** Values of keyField that already exist on the record type (read-only SuiteQL), or undefined if it cannot be checked. */
export async function existingKeys(ns: NsRequester, recordType: string, keyField: string, values: string[]): Promise<Set<string> | undefined> {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(recordType) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(keyField)) return undefined;
  const column = keyField.toLowerCase();
  const found = new Set<string>();
  try {
    for (const part of chunks([...new Set(values.map((v) => v.trim()).filter(Boolean))], 500)) {
      const rows = await collect(
        suiteqlOffset<Record<string, unknown>>(ns, `SELECT t.${column} AS k FROM ${recordType.toLowerCase()} t WHERE t.${column} IN (${part.map(literal).join(", ")})`),
      );
      for (const row of rows) if (row.k !== null && row.k !== undefined) found.add(String(row.k));
    }
    return found;
  } catch (error) {
    if (error instanceof NsHttpError) return undefined;
    throw error;
  }
}
