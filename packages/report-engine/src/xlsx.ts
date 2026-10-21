import { cellText, neutraliseFormula, plainNumber, type ReportRow } from "./csv";
import type { ReportColumn } from "./definition";
import { zip } from "./zip";

const xml = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Column letters: 0 -> A, 25 -> Z, 26 -> AA. */
function colName(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Excel date serial (days since 1899-12-30) for YYYY-MM-DD, or undefined. */
function dateSerial(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(t) ? undefined : Math.round((t - Date.UTC(1899, 11, 30)) / 86_400_000);
}

// Style ids in styles.xml: 0 default, 1 date, 2 currency (#,##0.00), 3 bold header.
const STYLE = { date: 1, currency: 2, header: 3 } as const;

function cell(ref: string, column: ReportColumn, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (column.type === "date") {
    const serial = dateSerial(value);
    if (serial !== undefined) return `<c r="${ref}" s="${STYLE.date}"><v>${serial}</v></c>`;
  } else if (column.type !== "text") {
    const n = plainNumber(value);
    if (n !== undefined) return `<c r="${ref}"${column.type === "currency" ? ` s="${STYLE.currency}"` : ""}><v>${n}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t>${xml(cellText({ ...column, type: "text" }, value))}</t></is></c>`;
}

/** A one-sheet XLSX workbook with a bold header row, typed numbers and dates, and text kept as text. */
export function toXlsx(sheetTitle: string, columns: ReportColumn[], rows: ReportRow[]): Buffer {
  const header = columns
    .map((c, i) => `<c r="${colName(i)}1" s="${STYLE.header}" t="inlineStr"><is><t>${xml(neutraliseFormula(c.label))}</t></is></c>`)
    .join("");
  const body = rows
    .map((row, r) => `<row r="${r + 2}">${columns.map((c, i) => cell(`${colName(i)}${r + 2}`, c, row[c.key])).join("")}</row>`)
    .join("");
  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews>` +
    `<sheetData><row r="1">${header}</row>${body}</sheetData></worksheet>`;
  // Sheet names: at most 31 characters, none of []:*?/\
  const name = xml(sheetTitle.replace(/[[\]:*?/\\]/g, " ").slice(0, 31) || "Report");
  const files = {
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      "</Types>",
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      "</Relationships>",
    "xl/workbook.xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      "</Relationships>",
    "xl/styles.xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="4">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      "</cellXfs></styleSheet>",
    "xl/worksheets/sheet1.xml": sheet,
  };
  return zip(Object.entries(files).map(([n, d]) => ({ name: n, data: Buffer.from(d, "utf8") })));
}
