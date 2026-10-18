import { describe, expect, it } from "vitest";
import { QueryRejectedError, assertSelectOnly, identifier, literal } from "../src";

describe("assertSelectOnly", () => {
  it.each([
    "SELECT id, companyname FROM customer WHERE ROWNUM <= 10",
    "  select type, COUNT(id) AS n FROM transaction GROUP BY type;  ",
    "(SELECT id FROM vendor)",
    "SELECT id FROM customer WHERE companyname = 'Update; Drop Ltd'",
    "SELECT id FROM item -- delete this comment later\n WHERE isinactive = 'F'",
  ])("allows %s", (q) => {
    expect(() => assertSelectOnly(q)).not.toThrow();
  });

  it.each([
    ["", /empty/],
    ["DELETE FROM customer", /Only SELECT/],
    ["WITH x AS (SELECT 1 FROM DUAL) SELECT * FROM x", /Only SELECT/],
    ["SELECT 1 FROM DUAL; SELECT 2 FROM DUAL", /one statement/],
    ["SELECT id FROM customer WHERE id IN (SELECT id FROM t) UNION SELECT 1 FROM DUAL; DROP TABLE x", /one statement/],
    ["SELECT * FROM customer WHERE 1 = 1 /* */ UPDATE", /UPDATE/],
  ])("rejects %s", (q, message) => {
    expect(() => assertSelectOnly(q)).toThrow(message);
  });

  it("strips a single trailing semicolon", () => {
    expect(assertSelectOnly("SELECT 1 FROM DUAL;")).toBe("SELECT 1 FROM DUAL");
  });

  it("raises a typed error", () => {
    expect(() => assertSelectOnly("DROP TABLE x")).toThrow(QueryRejectedError);
  });
});

describe("literal and identifier", () => {
  it("escapes quotes", () => expect(literal("O'Brien")).toBe("'O''Brien'"));
  it("rejects unsafe identifiers", () => {
    expect(identifier("companyname")).toBe("companyname");
    expect(() => identifier("name; --")).toThrow(QueryRejectedError);
  });
});
