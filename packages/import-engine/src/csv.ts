export interface ParsedCsv {
  headers: string[];
  /** Data rows, each with exactly headers.length values. */
  rows: string[][];
}

/** RFC 4180 CSV: quoted fields, doubled quotes, embedded commas and newlines, CRLF or LF, optional BOM. */
export function parseCsv(text: string): ParsedCsv {
  const src = text.replace(/^﻿/, "");
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i += 2;
      } else if (ch === '"') {
        quoted = false;
        i++;
      } else {
        field += ch;
        i++;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
    } else if (ch === ",") {
      record.push(field);
      field = "";
      i++;
    } else if (ch === "\r" || ch === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (quoted) throw new Error("unterminated quote in the CSV");
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const nonEmpty = records.filter((r) => !(r.length === 1 && r[0] === ""));
  if (nonEmpty.length === 0) throw new Error("the CSV is empty");

  const headers = nonEmpty[0]!.map((h) => h.trim());
  const seen = new Set<string>();
  for (const h of headers) {
    if (!h) throw new Error("the header row has an empty column name");
    if (seen.has(h.toLowerCase())) throw new Error(`duplicate column "${h}" in the header row`);
    seen.add(h.toLowerCase());
  }
  const rows = nonEmpty.slice(1);
  rows.forEach((r, k) => {
    if (r.length !== headers.length) {
      throw new Error(`line ${k + 2} has ${r.length} values; the header has ${headers.length}`);
    }
  });
  return { headers, rows };
}
