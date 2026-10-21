import { assertSelectOnly, literal } from "@ns-agent/suiteql";
import type { ReportDefinition, ReportParam } from "./definition";

/** A parameter value the caller supplied is missing, malformed or unknown. Nothing was sent to NetSuite. */
export class ReportParamError extends Error {
  override readonly name = "ReportParamError";
}

export type ParamValues = Record<string, unknown>;

/** Blanks string literals and comments character for character, so positions still match the query. */
export function maskKeepingLength(sql: string): string {
  const out = sql.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < sql.length) {
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      blank(i, Math.min(j + 1, sql.length));
      i = j + 1;
    } else if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      const j = end === -1 ? sql.length : end;
      blank(i, j);
      i = j;
    } else if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      const j = end === -1 ? sql.length : end + 2;
      blank(i, j);
      i = j;
    } else i++;
  }
  return out.join("");
}

const isoDate = (now: Date) => now.toISOString().slice(0, 10);

function bindOne(p: ReportParam, raw: unknown): string {
  switch (p.type) {
    case "date": {
      if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new ReportParamError(`${p.name} must be a date as YYYY-MM-DD`);
      const d = new Date(`${raw}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || isoDate(d) !== raw) throw new ReportParamError(`${p.name}: ${raw} is not a real date`);
      return `TO_DATE('${raw}', 'YYYY-MM-DD')`;
    }
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
      if (!Number.isFinite(n)) throw new ReportParamError(`${p.name} must be a number`);
      return String(n);
    }
    case "id": {
      const s = String(raw).trim();
      if (!/^\d{1,12}$/.test(s)) throw new ReportParamError(`${p.name} must be a NetSuite internal id (digits)`);
      return s;
    }
    case "idList": {
      const list = Array.isArray(raw) ? raw : String(raw).split(",");
      if (list.length === 0 || list.length > 500) throw new ReportParamError(`${p.name} needs at least one and at most 500 ids`);
      return list
        .map((v) => {
          const s = String(v).trim();
          if (!/^\d{1,12}$/.test(s)) throw new ReportParamError(`${p.name} must list NetSuite internal ids (digits)`);
          return s;
        })
        .join(", ");
    }
    case "string": {
      if (typeof raw !== "string" || raw.length > 200) throw new ReportParamError(`${p.name} must be text of at most 200 characters`);
      return literal(raw);
    }
  }
}

/**
 * Turns a definition and caller values into one SuiteQL SELECT. Values become validated literals; nothing the
 * caller passes is ever placed into the query as raw text.
 */
export function bindParams(def: ReportDefinition, values: ParamValues, now: () => Date = () => new Date()): string {
  const known = new Map(def.params.map((p) => [p.name, p]));
  for (const name of Object.keys(values)) {
    if (!known.has(name)) throw new ReportParamError(`unknown parameter ${name} for report ${def.id}`);
  }
  const bound = new Map<string, string>();
  for (const p of def.params) {
    let raw = values[p.name];
    if ((raw === undefined || raw === null || raw === "") && p.default !== undefined) {
      raw = p.type === "date" && p.default === "today" ? isoDate(now()) : p.default;
    }
    if (raw === undefined || raw === null || raw === "") {
      if (p.required) throw new ReportParamError(`${p.name} is required for report ${def.id}`);
      continue;
    }
    bound.set(p.name, bindOne(p, raw));
  }

  // Optional sections: keep the body when the param has a value, drop it otherwise.
  let q = def.query.replace(/\{\{#([a-z0-9_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, name: string, body: string) =>
    bound.has(name) ? body : " ",
  );

  // Replace :name only outside string literals and comments, using the masked copy to find positions.
  const masked = maskKeepingLength(q);
  let out = "";
  let last = 0;
  for (const m of masked.matchAll(/(?<![:\w]):([a-z][a-z0-9_]*)\b/g)) {
    const value = bound.get(m[1]!);
    if (value === undefined) throw new ReportParamError(`${m[1]} is required for report ${def.id}`);
    out += q.slice(last, m.index) + value;
    last = m.index! + m[0].length;
  }
  q = (out + q.slice(last)).replace(/[ \t]{2,}/g, " ").trim();
  return assertSelectOnly(q);
}
