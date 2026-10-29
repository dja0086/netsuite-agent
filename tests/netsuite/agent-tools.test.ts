import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../netsuite/src/FileCabinet/SuiteScripts/ns_agent");

/** Runs a SuiteScript AMD module the way NetSuite would, with the given modules for its dependencies. */
function load<T>(file: string, modules: Record<string, unknown> = {}): T {
  let result!: T;
  new Function("define", readFileSync(path.join(root, file), "utf8"))((deps: string[], factory: (...m: unknown[]) => T) => {
    result = factory(
      ...deps.map((d) => {
        if (!(d in modules)) throw new Error(`unexpected dependency ${d}`);
        return modules[d];
      }),
    );
  });
  return result;
}

interface Guards {
  ToolInputError: new (m: string) => Error;
  MAX_ROWS: number;
  assertSelectOnly(q: unknown): string;
  rowLimit(v: unknown): number;
  identifier(v: unknown, what: string): string;
  recordId(v: unknown): number;
  fieldList(v: unknown): string[];
}
const guards = load<Guards>("lib/tool_guards.js");

describe("tool_guards", () => {
  it("accepts one SELECT, trimming a trailing semicolon", () => {
    expect(guards.assertSelectOnly("  SELECT COUNT(t.id) AS n FROM transaction t; ")).toBe("SELECT COUNT(t.id) AS n FROM transaction t");
    expect(guards.assertSelectOnly("(SELECT id FROM customer)")).toBe("(SELECT id FROM customer)");
    expect(guards.assertSelectOnly("SELECT 'DELETE; DROP' AS x FROM dual")).toContain("DELETE; DROP");
  });

  it.each([
    ["", "empty"],
    ["DELETE FROM customer", "Only SELECT"],
    ["WITH a AS (SELECT 1 FROM dual) SELECT * FROM a", "Only SELECT"],
    ["SELECT 1 FROM dual; SELECT 2 FROM dual", "one statement"],
    ["SELECT id FROM customer WHERE 1=1 /* x */ UNION SELECT 1 FROM dual; DROP TABLE x", "one statement"],
    ["SELECT id FROM (DELETE FROM customer)", "DELETE"],
    [42, "must be a string"],
  ])("refuses %j", (q, message) => {
    expect(() => guards.assertSelectOnly(q)).toThrow(message as string);
  });

  it("caps rows at 200 and defaults to 50", () => {
    expect(guards.rowLimit(undefined)).toBe(50);
    expect(guards.rowLimit(200)).toBe(200);
    expect(() => guards.rowLimit(201)).toThrow("1 to 200");
    expect(() => guards.rowLimit(0)).toThrow("1 to 200");
    expect(() => guards.rowLimit(2.5)).toThrow("1 to 200");
  });

  it("checks identifiers, ids and field lists", () => {
    expect(guards.identifier("customer", "type")).toBe("customer");
    expect(() => guards.identifier("customer; drop", "type")).toThrow("plain identifier");
    expect(guards.recordId(2815)).toBe(2815);
    expect(guards.recordId("2815")).toBe(2815);
    expect(() => guards.recordId(-1)).toThrow("positive internal id");
    expect(() => guards.recordId("1 OR 1=1")).toThrow("positive internal id");
    expect(guards.fieldList(" id, CompanyName ,email,id ")).toEqual(["id", "companyname", "email"]);
    expect(() => guards.fieldList("id, (SELECT 1)")).toThrow("plain identifier");
    expect(() => guards.fieldList(Array.from({ length: 51 }, (_, i) => `f${i}`).join(","))).toThrow("more than 50");
    expect(() => guards.fieldList("")).toThrow("at least one field");
  });
});

/** A fake N/query that records calls and serves rows. */
function fakeQuery(rows: Record<string, unknown>[], fail?: Error) {
  const calls: { kind: string; options: Record<string, unknown> }[] = [];
  return {
    calls,
    module: {
      runSuiteQLPaged(options: { query: string; pageSize: number }) {
        calls.push({ kind: "paged", options });
        if (fail) throw fail;
        return {
          count: rows.length,
          fetch: ({ index }: { index: number }) => ({ data: { asMappedResults: () => rows.slice(index * options.pageSize, (index + 1) * options.pageSize) } }),
        };
      },
      runSuiteQL(options: { query: string; params: unknown[] }) {
        calls.push({ kind: "run", options });
        if (fail) throw fail;
        return { asMappedResults: () => rows };
      },
    },
  };
}

type Tools = Record<"nsagent_suiteql" | "nsagent_record_get", (args: Record<string, unknown>) => Promise<Record<string, unknown>>>;
const loadTools = (q: ReturnType<typeof fakeQuery>) => load<Tools>("tools/agent_tools.js", { "N/query": q.module, "../lib/tool_guards": guards });

describe("agent_tools.js", () => {
  it("is a CustomTool script that loads only N/query and the guards", () => {
    const source = readFileSync(path.join(root, "tools/agent_tools.js"), "utf8");
    expect(source).toContain("@NScriptType CustomTool");
    expect(source).toMatch(/define\(\['N\/query', '\.\.\/lib\/tool_guards'\]/);
    expect(source).not.toMatch(/N\/(https?|llm|sftp|record)\b/);
  });

  it("exports exactly the tools the schema declares", () => {
    const schema = JSON.parse(readFileSync(path.join(root, "tools/agent_tools_schema.json"), "utf8")) as { tools: { name: string; annotations: Record<string, boolean> }[] };
    const tools = loadTools(fakeQuery([]));
    expect(Object.keys(tools).sort()).toEqual(schema.tools.map((t) => t.name).sort());
    for (const t of schema.tools) expect(t.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  it("nsagent_suiteql returns capped rows and hasMore", async () => {
    const q = fakeQuery(Array.from({ length: 12 }, (_, i) => ({ id: i + 1 })));
    const r = await loadTools(q).nsagent_suiteql({ query: "SELECT id FROM customer", limit: 3 });
    expect(r).toEqual({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }], rowCount: 3, hasMore: true });
    expect(q.calls[0]).toEqual({ kind: "paged", options: { query: "SELECT id FROM customer", pageSize: 5 } });
  });

  it("nsagent_suiteql returns an empty result and input errors without calling NetSuite", async () => {
    expect(await loadTools(fakeQuery([])).nsagent_suiteql({ query: "SELECT id FROM customer" })).toEqual({ rows: [], rowCount: 0, hasMore: false });
    const q = fakeQuery([]);
    expect(await loadTools(q).nsagent_suiteql({ query: "DELETE FROM customer" })).toEqual({ error: expect.stringContaining("Only SELECT") });
    expect(q.calls).toEqual([]);
  });

  it("nsagent_suiteql reports NetSuite errors as error text", async () => {
    const r = await loadTools(fakeQuery([], new Error("Search error occurred: Record 'nope' was not found."))).nsagent_suiteql({ query: "SELECT id FROM nope" });
    expect(r).toEqual({ error: "NetSuite rejected the query: Search error occurred: Record 'nope' was not found." });
  });

  it("nsagent_record_get binds the id and selects only the checked fields", async () => {
    const q = fakeQuery([{ id: 2815, companyname: "Acme" }]);
    const r = await loadTools(q).nsagent_record_get({ type: "customer", id: 2815, fields: "id, companyname" });
    expect(r).toEqual({ record: { id: 2815, companyname: "Acme" } });
    expect(q.calls[0]).toEqual({ kind: "run", options: { query: "SELECT id, companyname FROM customer WHERE id = ?", params: [2815] } });
  });

  it("nsagent_record_get refuses bad input and reports a missing record", async () => {
    const q = fakeQuery([]);
    const tools = loadTools(q);
    expect(await tools.nsagent_record_get({ type: "customer x", id: 1, fields: "id" })).toEqual({ error: expect.stringContaining("plain identifier") });
    expect(await tools.nsagent_record_get({ type: "customer", id: "1 OR 1=1", fields: "id" })).toEqual({ error: "id must be a positive internal id" });
    expect(q.calls).toEqual([]);
    expect(await tools.nsagent_record_get({ type: "customer", id: 99999999, fields: "id" })).toEqual({ error: "No customer with internal id 99999999, or this role cannot see it" });
  });
});
