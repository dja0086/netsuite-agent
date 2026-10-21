import { inflateRawSync } from "node:zlib";
import type { NsRequest, NsRequester } from "@ns-agent/ns-client";
import { describe, expect, it } from "vitest";
import {
  ReportDefinition,
  ReportParamError,
  bindParams,
  plainNumber,
  runReport,
  toCsv,
  toXlsx,
  type ReportColumn,
} from "../src";

const AGING = ReportDefinition.parse({
  id: "ar-aging",
  title: "AR aging",
  description: "Open invoice balances by customer and currency, in age buckets.",
  params: [
    { name: "as_of", type: "date", required: true },
    { name: "subsidiary", type: "id" },
  ],
  query:
    "SELECT BUILTIN.DF(t.entity) AS customer, COUNT(t.id) AS n FROM transaction t " +
    "WHERE t.duedate < :as_of AND t.memo <> ':as_of is not a param here' {{#subsidiary}}AND t.subsidiary = :subsidiary{{/subsidiary}} " +
    "GROUP BY BUILTIN.DF(t.entity)",
  columns: [
    { key: "customer", label: "Customer", type: "text" },
    { key: "n", label: "Invoices", type: "integer" },
  ],
});

describe("ReportDefinition", () => {
  it("rejects placeholders that are not declared params", () => {
    expect(() =>
      ReportDefinition.parse({ ...AGING, params: [], query: "SELECT id FROM customer WHERE id = :nope" }),
    ).toThrow(/nope/);
  });

  it("rejects ids that are not kebab-case and queries that are not SELECT", () => {
    expect(() => ReportDefinition.parse({ ...AGING, id: "AR Aging" })).toThrow();
    expect(() => ReportDefinition.parse({ ...AGING, query: "DELETE FROM customer" })).toThrow(/SELECT/);
  });
});

describe("bindParams", () => {
  it("binds dates as TO_DATE literals and drops optional sections that have no value", () => {
    const q = bindParams(AGING, { as_of: "2026-10-21" });
    expect(q).toContain("t.duedate < TO_DATE('2026-10-21', 'YYYY-MM-DD')");
    expect(q).toContain("':as_of is not a param here'"); // placeholders inside string literals are left alone
    expect(q).not.toContain("subsidiary =");
  });

  it("keeps optional sections when the value is given", () => {
    expect(bindParams(AGING, { as_of: "2026-10-21", subsidiary: "3" })).toContain("AND t.subsidiary = 3");
  });

  it("validates every type and refuses injection", () => {
    expect(() => bindParams(AGING, {})).toThrow(ReportParamError);
    expect(() => bindParams(AGING, { as_of: "21/10/2026" })).toThrow(/YYYY-MM-DD/);
    expect(() => bindParams(AGING, { as_of: "2026-02-30" })).toThrow(/not a real date/);
    expect(() => bindParams(AGING, { as_of: "2026-10-21", subsidiary: "3 OR 1=1" })).toThrow(/internal id/);
    expect(() => bindParams(AGING, { as_of: "2026-10-21", extra: "x" })).toThrow(/unknown parameter extra/);
  });

  it("quotes strings, checks numbers and id lists", () => {
    const def = ReportDefinition.parse({
      ...AGING,
      params: [
        { name: "name", type: "string" },
        { name: "min", type: "number" },
        { name: "ids", type: "idList" },
      ],
      query: "SELECT id FROM customer WHERE companyname = :name AND balance > :min AND id IN (:ids)",
    });
    expect(bindParams(def, { name: "O'Brien", min: 10.5, ids: ["1", "22"] })).toBe(
      "SELECT id FROM customer WHERE companyname = 'O''Brien' AND balance > 10.5 AND id IN (1, 22)",
    );
    expect(() => bindParams(def, { name: "x", min: "1e9; DROP", ids: ["1"] })).toThrow(/number/);
    expect(() => bindParams(def, { name: "x", min: 1, ids: [] })).toThrow(/at least one/);
  });

  it("fills defaults, including the 'today' date", () => {
    const def = ReportDefinition.parse({ ...AGING, params: [{ name: "as_of", type: "date", default: "today" }, { name: "subsidiary", type: "id" }] });
    expect(bindParams(def, {}, () => new Date("2026-10-21T15:00:00Z"))).toContain("TO_DATE('2026-10-21', 'YYYY-MM-DD')");
  });
});

describe("plainNumber", () => {
  it("never uses scientific notation", () => {
    expect(plainNumber("3.381844953E7")).toBe("33818449.53");
    expect(plainNumber("1.5E-7")).toBe("0.00000015");
    expect(plainNumber("-12")).toBe("-12");
    expect(plainNumber("abc")).toBeUndefined();
  });
});

const COLS: ReportColumn[] = [
  { key: "customer", label: "Customer", type: "text" },
  { key: "due", label: "Due", type: "date" },
  { key: "amount", label: "Amount", type: "currency" },
];

describe("toCsv", () => {
  it("writes RFC 4180 CSV with headers, plain numbers and escaped text", () => {
    const csv = toCsv(COLS, [
      { customer: 'Acme, "Ltd"', due: "2026-10-01", amount: "3.381844953E7" },
      { customer: "Line\nbreak", due: null, amount: null },
    ]);
    expect(csv).toBe('Customer,Due,Amount\r\n"Acme, ""Ltd""",2026-10-01,33818449.53\r\n"Line\nbreak",,\r\n');
  });

  it("neutralises spreadsheet formulas in text cells", () => {
    expect(toCsv([COLS[0]!], [{ customer: "=HYPERLINK(\"x\")" }, { customer: "+1" }, { customer: "@a" }])).toBe(
      "Customer\r\n\"'=HYPERLINK(\"\"x\"\")\"\r\n'+1\r\n'@a\r\n",
    );
  });
});

/** Minimal reader for the archives toXlsx writes (no data descriptors, deflate or store). */
function unzip(buf: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString("utf8");
    const start = i + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + size);
    files.set(name, (method === 8 ? inflateRawSync(data) : data).toString("utf8"));
    i = start + size;
  }
  expect(buf.readUInt32LE(buf.length - 22)).toBe(0x06054b50); // end of central directory
  return files;
}

describe("toXlsx", () => {
  it("writes a workbook with typed cells", () => {
    const files = unzip(
      toXlsx("AR aging", COLS, [{ customer: "Acme & Co <x>", due: "2026-10-01", amount: "1.5E3" }, { customer: "=cmd", due: "bad", amount: null }]),
    );
    expect([...files.keys()].sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    const sheet = files.get("xl/worksheets/sheet1.xml")!;
    expect(sheet).toContain("<t>Acme &amp; Co &lt;x&gt;</t>");
    expect(sheet).toContain('<c r="C2" s="2"><v>1500</v></c>'); // currency style
    expect(sheet).toContain('<c r="B2" s="1"><v>46296</v></c>'); // 2026-10-01 as an Excel date serial
    expect(sheet).toContain("<t>bad</t>"); // unparsable dates stay text
    expect(sheet).toContain("<t>'=cmd</t>");
    expect(files.get("xl/workbook.xml")).toContain('name="AR aging"');
  });
});

describe("runReport", () => {
  it("binds, pages and stops at maxRows, reporting truncation", async () => {
    const requests: NsRequest[] = [];
    const ns: NsRequester = {
      async request<T>(req: NsRequest): Promise<T> {
        requests.push(req);
        const offset = Number(req.query?.offset ?? 0);
        const items = Array.from({ length: 3 }, (_, k) => ({ customer: `C${offset + k}`, n: "1" }));
        return { items, hasMore: offset < 6, count: 3, offset, totalResults: 9 } as T;
      },
    };
    const res = await runReport(ns, AGING, { as_of: "2026-10-21" }, { maxRows: 5, pageSize: 3 });
    expect(res.rows).toHaveLength(5);
    expect(res.truncated).toBe(true);
    expect((requests[0]!.body as { q: string }).q).toContain("TO_DATE('2026-10-21', 'YYYY-MM-DD')");
  });
});
