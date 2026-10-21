import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NsRequest, NsRequester } from "@ns-agent/ns-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DenyAllApprovals, MemoryAuditSink, createGateway, type LoadedSkill } from "../src";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ns-reports-"));
  const defs = path.join(dir, "definitions");
  mkdirSync(defs);
  writeFileSync(
    path.join(defs, "customer-list.yaml"),
    [
      "id: customer-list",
      "title: Customer list",
      "description: Customers with their tax id, for testing redaction in files.",
      "params:",
      "  - { name: min_balance, type: number, default: 0 }",
      "query: SELECT id, companyname, taxidnum, balance FROM customer WHERE balance >= :min_balance",
      "columns:",
      "  - { key: companyname, label: Company }",
      "  - { key: taxidnum, label: Tax id }",
      "  - { key: balance, label: Balance, type: currency }",
    ].join("\n"),
  );
  process.env.NS_AGENT_REPORTS_DIR = defs;
  process.env.NS_AGENT_EXPORT_DIR = path.join(dir, "exports");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.NS_AGENT_REPORTS_DIR;
  delete process.env.NS_AGENT_EXPORT_DIR;
});

const skill: LoadedSkill = {
  dir: "/skills/reports",
  body: "",
  manifest: {
    name: "reports",
    description: "test skill description that is long enough to pass validation",
    version: "0.1.0",
    owner: "@t",
    tools: ["ns_report_list", "ns_report_run", "ns_report_export_query"],
    writes: false,
    enabled: true,
    platform: false,
    deprecated: false,
    governance_budget: { max_calls_per_invocation: 10, max_concurrency: 1 },
  },
};

async function connect() {
  const queries: string[] = [];
  const ns: NsRequester = {
    async request<T>(req: NsRequest): Promise<T> {
      queries.push((req.body as { q: string }).q);
      return {
        items: [{ id: "1", companyname: "=Acme", taxidnum: "12-3456789", balance: "1.5E3", links: [] }],
        hasMore: false,
        count: 1,
        offset: 0,
        totalResults: 1,
      } as T;
    },
  };
  const { server } = createGateway({
    ns,
    skills: [skill],
    audit: new MemoryAuditSink(),
    approvals: new DenyAllApprovals(),
    redactFields: new Set(["taxidnum"]),
    accountId: "TSTDRV1755417",
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    return { isError: Boolean(res.isError), text, json: res.isError ? undefined : JSON.parse(text) };
  };
  return { call, queries };
}

describe("report tools", () => {
  it("lists definitions with their parameters", async () => {
    const { call } = await connect();
    const res = await call("ns_report_list", {});
    expect(res.json).toMatchObject({ count: 1, reports: [{ id: "customer-list", params: [{ name: "min_balance", type: "number" }] }] });
  });

  it("runs a report to CSV with bound params, redaction applied inside the file", async () => {
    const { call, queries } = await connect();
    const res = await call("ns_report_run", { reportId: "customer-list", params: { min_balance: 100 }, format: "csv" });
    expect(res.json).toMatchObject({ format: "csv", rowCount: 1, truncated: false, columns: ["Company", "Tax id", "Balance"] });
    expect(queries[0]).toContain("balance >= 100");
    const csv = readFileSync(res.json.file, "utf8");
    expect(csv).toBe("Company,Tax id,Balance\r\n'=Acme,[REDACTED],1500\r\n");
    expect(res.json.sample[0].taxidnum).toBe("[REDACTED]");
    expect(path.dirname(res.json.file)).toBe(path.join(dir, "exports"));
  });

  it("refuses unknown reports and bad parameters before calling NetSuite", async () => {
    const { call, queries } = await connect();
    const unknown = await call("ns_report_run", { reportId: "nope" });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/unknown report nope/);
    const bad = await call("ns_report_run", { reportId: "customer-list", params: { min_balance: "1; DROP" } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/must be a number/);
    expect(queries).toHaveLength(0);
  });

  it("exports an ad-hoc SELECT to XLSX and rejects anything else", async () => {
    const { call, queries } = await connect();
    const ok = await call("ns_report_export_query", { q: "SELECT id, companyname FROM customer", title: "Customers", format: "xlsx" });
    expect(ok.json).toMatchObject({ format: "xlsx", rowCount: 1 });
    expect(readFileSync(ok.json.file).subarray(0, 2).toString()).toBe("PK");
    const dml = await call("ns_report_export_query", { q: "DELETE FROM customer", title: "never", format: "csv" });
    expect(dml.isError).toBe(true);
    expect(queries).toHaveLength(1);
  });
});
