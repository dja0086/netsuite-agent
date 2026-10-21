import type { ReportColumn } from "./definition";

export type ReportRow = Record<string, unknown>;

/** Formats a numeric string or number without scientific notation; undefined if it is not a number. */
export function plainNumber(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const s = String(value).trim();
  if (!/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return undefined;
  const [mantissa, expPart] = s.toLowerCase().split("e");
  const exp = Number(expPart ?? 0);
  const negative = mantissa!.startsWith("-");
  const [intPart, fracPart = ""] = mantissa!.replace("-", "").split(".");
  let digits = (intPart || "0") + fracPart;
  let point = (intPart || "0").length + exp;
  if (point <= 0) {
    digits = "0".repeat(1 - point) + digits;
    point = 1;
  } else if (point > digits.length) digits += "0".repeat(point - digits.length);
  let int = digits.slice(0, point).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(point).replace(/0+$/, "");
  if (!int) int = "0";
  const out = frac ? `${int}.${frac}` : int;
  return negative && out !== "0" ? `-${out}` : out;
}

/** Text that a spreadsheet would run as a formula gets a leading apostrophe (CSV/formula injection). */
export function neutraliseFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

/** One cell's text as it appears in an export, by column type. */
export function cellText(column: ReportColumn, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (column.type === "integer" || column.type === "number" || column.type === "currency") {
    return plainNumber(value) ?? neutraliseFormula(String(value));
  }
  if (typeof value === "object") return neutraliseFormula(JSON.stringify(value));
  return neutraliseFormula(String(value));
}

const quote = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** RFC 4180 CSV with a header row and CRLF line ends. */
export function toCsv(columns: ReportColumn[], rows: ReportRow[]): string {
  const lines = [columns.map((c) => quote(c.label)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => quote(cellText(c, row[c.key]))).join(","));
  return lines.join("\r\n") + "\r\n";
}
