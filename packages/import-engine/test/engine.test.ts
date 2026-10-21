import { describe, expect, it } from "vitest";
import { classifyFields, dryRun, parseCsv, requiredFields, suggestMapping, type ImportField } from "../src";

const SCHEMA = {
  properties: {
    externalId: { title: "External ID", type: "string", nullable: true },
    companyName: { title: "Company Name", type: "string", nullable: true },
    email: { title: " Email", type: "string", nullable: true },
    creditLimit: { title: "Credit Limit", type: "number", format: "double" },
    startDate: { title: "Start Date", type: "string", format: "date" },
    isPerson: { title: "Is Individual", type: "boolean" },
    subsidiary: { type: "object", properties: { id: { type: "string" }, refName: { type: "string" } } },
    currency: { type: "object", properties: { id: { type: "string" }, refName: { type: "string" } } },
    terms: { type: "object", properties: { id: { type: "string" }, refName: { type: "string" } } },
    addressBook: { type: "object", properties: { items: { type: "array" } } },
    balance: { title: "Balance", type: "number", readOnly: true },
    id: { title: "Internal ID", type: "string" },
  },
};

const CSV =
  "﻿External ID,Company Name,Email,Subsidiary,Currency,Credit Limit,Start Date,Shoe Size\r\n" +
  "nsagent-eval-001,Example Widgets Ltd,ap@example.com,US West,USD,5000,2026-01-15,9\r\n" +
  "nsagent-eval-002,Sample Parts GmbH,not-an-email,EMEA,EUR,abc,2026-02-30,10\r\n" +
  "nsagent-eval-003,,billing@example.org,No Such Subsidiary,USD,,2026-03-01,8\r\n" +
  'nsagent-eval-001,"Duplicate Row, Inc",dup@example.com,1,XYZ,100,15/03/2026,7\r\n';

describe("parseCsv", () => {
  it("handles a BOM, quotes, embedded commas, newlines and doubled quotes", () => {
    const { headers, rows } = parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\n1,\n');
    expect(headers).toEqual(["a", "b"]);
    expect(rows).toEqual([
      ["x, y", 'say "hi"\nthere'],
      ["1", ""],
    ]);
  });

  it("rejects duplicate or empty headers and ragged rows", () => {
    expect(() => parseCsv("a,a\n1,2\n")).toThrow(/duplicate column "a"/);
    expect(() => parseCsv("a,\n1,2\n")).toThrow(/empty column name/);
    expect(() => parseCsv("a,b\n1\n")).toThrow(/line 2 has 1 values; the header has 2/);
    expect(() => parseCsv('a\n"open\n')).toThrow(/unterminated quote/);
  });
});

describe("classifyFields", () => {
  it("keeps importable body fields with their kind and drops sublists, read-only and id", () => {
    const fields = classifyFields(SCHEMA);
    const kinds = Object.fromEntries(fields.map((f) => [f.id, f.kind]));
    expect(kinds).toEqual({
      externalId: "string",
      companyName: "string",
      email: "email",
      creditLimit: "number",
      startDate: "date",
      isPerson: "boolean",
      subsidiary: "reference",
      currency: "reference",
      terms: "reference",
    });
    expect(fields.find((f) => f.id === "email")!.label).toBe("Email");
  });
});

describe("suggestMapping", () => {
  it("matches headers to field ids or labels, ignoring case and punctuation", () => {
    const fields = classifyFields(SCHEMA);
    const m = suggestMapping(["External ID", "company_name", "E-mail", "Subsidiary", "Is Individual", "Shoe Size"], fields);
    expect(m.map((c) => [c.header, c.field, c.match])).toEqual([
      ["External ID", "externalId", "id"],
      ["company_name", "companyName", "id"],
      ["E-mail", "email", "id"],
      ["Subsidiary", "subsidiary", "id"],
      ["Is Individual", "isPerson", "label"],
      ["Shoe Size", null, "none"],
    ]);
  });
});

describe("requiredFields", () => {
  it("knows the fields NetSuite always needs for common record types", () => {
    expect(requiredFields("customer", false)).toEqual(["companyName", "subsidiary"]);
    expect(requiredFields("customer", true)).toEqual(["firstName", "lastName", "subsidiary"]);
    expect(requiredFields("customrecord_x", false)).toEqual([]);
  });
});

describe("dryRun", () => {
  const fields: ImportField[] = classifyFields(SCHEMA);
  const { headers, rows } = parseCsv(CSV);
  const mapping = {
    "External ID": "externalId",
    "Company Name": "companyName",
    Email: "email",
    Subsidiary: "subsidiary",
    Currency: "currency",
    "Credit Limit": "creditLimit",
    "Start Date": "startDate",
  };
  const references = new Map([
    ["subsidiary", { verified: true, values: new Map([["us west", "1"], ["emea", "3"], ["1", "1"]]) }],
    ["currency", { verified: true, values: new Map([["usd", "1"], ["eur", "4"]]) }],
  ]);

  it("reports every problem with its file line, column and check", () => {
    const res = dryRun({ recordType: "customer", headers, rows, mapping, fields, references, keyField: "externalId", existingKeys: new Set() });
    expect(res).toMatchObject({ rowCount: 4, validRows: 1, invalidRows: 3 });
    const found = res.errors.map((e) => `${e.line} ${e.column} ${e.check}`);
    expect(found).toEqual([
      "3 Email format",
      "3 Credit Limit type",
      "3 Start Date type",
      "4 Company Name required",
      "4 Subsidiary reference",
      "5 External ID duplicate-in-file",
      "5 Currency reference",
      "5 Start Date type",
    ]);
    expect(res.errorsByCheck).toEqual({ format: 1, type: 3, required: 1, reference: 2, "duplicate-in-file": 1 });
    expect(res.errors.find((e) => e.check === "reference" && e.line === 4)!.message).toMatch(/No Such Subsidiary/);
  });

  it("flags keys that already exist in NetSuite", () => {
    const res = dryRun({
      recordType: "customer", headers, rows: rows.slice(0, 1), mapping, fields, references,
      keyField: "externalId", existingKeys: new Set(["nsagent-eval-001"]),
    });
    expect(res.errors).toEqual([expect.objectContaining({ line: 2, check: "exists-in-netsuite" })]);
  });

  it("lists reference fields it could not verify instead of passing them silently", () => {
    const res = dryRun({
      recordType: "customer", headers: ["Company Name", "Subsidiary", "Terms"], rows: [["A", "1", "Net 30"]],
      mapping: { "Company Name": "companyName", Subsidiary: "subsidiary", Terms: "terms" }, fields,
      references: new Map([...references, ["terms", { verified: false, values: new Map() }]]),
    });
    expect(res.validRows).toBe(1);
    expect(res.unverifiedReferences).toEqual(["terms"]);
  });

  it("refuses a mapping to an unknown or read-only field", () => {
    expect(() => dryRun({ recordType: "customer", headers, rows, mapping: { "Shoe Size": "shoeSize" }, fields, references })).toThrow(/shoeSize is not a customer field/);
    expect(() => dryRun({ recordType: "customer", headers, rows, mapping: { Email: "balance" }, fields, references })).toThrow(/balance is not a customer field/);
    expect(() => dryRun({ recordType: "customer", headers, rows, mapping: { Nope: "email" }, fields, references })).toThrow(/column "Nope" is not in the file/);
    expect(() => dryRun({ recordType: "customer", headers, rows, mapping: { Email: "email", "Company Name": "email" }, fields, references })).toThrow(/mapped twice/);
  });
});
