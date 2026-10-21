import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NsRequest, NsRequester } from "@ns-agent/ns-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DenyAllApprovals, MemoryAuditSink, createGateway, type LoadedSkill } from "../src";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ns-import-"));
  mkdirSync(path.join(dir, "imports"));
  writeFileSync(path.join(dir, "secret.csv"), "a\n1\n");
  writeFileSync(
    path.join(dir, "imports", "customers.csv"),
    "Company Name,Tax Number,Subsidiary\nAcme,12-3456789,US West\n,98-7654321,Nowhere\n",
  );
  symlinkSync(path.join(dir, "secret.csv"), path.join(dir, "imports", "link.csv"));
  process.env.NS_AGENT_IMPORT_DIR = path.join(dir, "imports");
  process.env.NS_AGENT_EXPORT_DIR = path.join(dir, "exports");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.NS_AGENT_IMPORT_DIR;
  delete process.env.NS_AGENT_EXPORT_DIR;
});

const skill: LoadedSkill = {
  dir: "/skills/data-importer",
  body: "",
  manifest: {
    name: "data-importer",
    description: "test skill description that is long enough to pass validation",
    version: "0.1.0",
    owner: "@t",
    tools: ["ns_import_plan", "ns_import_dry_run"],
    writes: false,
    enabled: true,
    platform: false,
    deprecated: false,
    governance_budget: { max_calls_per_invocation: 10, max_concurrency: 1 },
  },
};

async function connect() {
  const requests: NsRequest[] = [];
  const ns: NsRequester = {
    async request<T>(req: NsRequest): Promise<T> {
      requests.push(req);
      if (req.path.startsWith("/services/rest/record/v1/metadata-catalog/")) {
        return {
          properties: {
            companyName: { title: "Company Name", type: "string" },
            vatRegNumber: { title: "Tax Number", type: "integer" },
            subsidiary: { type: "object", properties: { id: { type: "string" }, refName: { type: "string" } } },
          },
        } as T;
      }
      if (req.method !== "POST" && req.method !== "GET") throw new Error(`unexpected ${req.method}`);
      const q = (req.body as { q: string }).q;
      if (q.includes("FROM subsidiary")) {
        return { items: [{ id: "1", name: "US West" }], hasMore: false, count: 1, offset: 0, totalResults: 1 } as T;
      }
      throw new Error(`unexpected query ${q}`);
    },
  };
  const { server } = createGateway({
    ns,
    skills: [skill],
    audit: new MemoryAuditSink(),
    approvals: new DenyAllApprovals(),
    redactFields: new Set(["vatregnumber"]),
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
  return { call, requests };
}

describe("data-importer tools", () => {
  it("plans a mapping by label and redacts the sample", async () => {
    const { call } = await connect();
    const res = await call("ns_import_plan", { file: "customers.csv", recordType: "customer" });
    expect(res.json.columns.map((c: { field: string }) => c.field)).toEqual(["companyName", "vatRegNumber", "subsidiary"]);
    expect(res.json.missingRequired).toEqual([]);
    expect(res.json.sample[0]).toEqual({ companyName: "Acme", vatRegNumber: "[REDACTED]", subsidiary: "US West" });
  });

  it("never reads outside the import folder: ../, absolute paths and symlinks", async () => {
    const { call, requests } = await connect();
    for (const file of ["../secret.csv", path.join(dir, "secret.csv"), "link.csv"]) {
      const res = await call("ns_import_plan", { file, recordType: "customer" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/inside the import folder/);
    }
    expect((await call("ns_import_plan", { file: "notes.txt", recordType: "customer" })).text).toMatch(/\.csv/);
    expect(requests).toHaveLength(0);
  });

  it("dry-runs every row, issues only read requests, and redacts values in the error file", async () => {
    const { call, requests } = await connect();
    const res = await call("ns_import_dry_run", {
      file: "customers.csv",
      recordType: "customer",
      mapping: { "Company Name": "companyName", "Tax Number": "vatRegNumber", Subsidiary: "subsidiary" },
    });
    expect(res.json).toMatchObject({ rowCount: 2, validRows: 0, invalidRows: 2, errorsByCheck: { type: 2, required: 1, reference: 1 } });
    const file = readFileSync(res.json.errorFile, "utf8");
    expect(file).toContain("required");
    expect(file).toContain('"Nowhere"');
    // The tax numbers fail the type check, and their values are masked in the file and in the response.
    expect(file.match(/\[REDACTED\]/g)).toHaveLength(2);
    expect(file).not.toContain("12-3456789");
    expect(file).not.toContain("98-7654321");
    expect(JSON.stringify(res.json.errors)).not.toContain("3456789");
    // Only metadata GETs and SuiteQL POSTs: nothing that could change a record.
    expect(requests.every((r) => r.method === "GET" || r.path === "/services/rest/query/v1/suiteql")).toBe(true);
  });
});
