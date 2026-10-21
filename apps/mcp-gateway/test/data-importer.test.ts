import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NsRequest, NsRequester } from "@ns-agent/ns-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  DenyAllApprovals,
  MemoryApprovalStore,
  MemoryAuditSink,
  StoredApprovals,
  createGateway,
  type ApprovalService,
  type LoadedSkill,
} from "../src";

let dir: string;
const VALID = "Company Name,Tax Number,Subsidiary\nAcme,123,US West\nBeta,456,1\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ns-import-"));
  mkdirSync(path.join(dir, "imports"));
  writeFileSync(path.join(dir, "secret.csv"), "a\n1\n");
  writeFileSync(
    path.join(dir, "imports", "customers.csv"),
    "Company Name,Tax Number,Subsidiary\nAcme,12-3456789,US West\n,98-7654321,Nowhere\n",
  );
  symlinkSync(path.join(dir, "secret.csv"), path.join(dir, "imports", "link.csv"));
  writeFileSync(path.join(dir, "imports", "valid.csv"), VALID);
  writeFileSync(path.join(dir, "imports", "five.csv"), "Company Name,Subsidiary\n" + ["A", "B", "C", "D", "E", "F", "G"].map((n) => `${n},US West`).join("\n") + "\n");
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
    tools: ["ns_import_plan", "ns_import_dry_run", "ns_import_run"],
    writes: true,
    enabled: true,
    platform: false,
    deprecated: false,
    governance_budget: { max_calls_per_invocation: 10, max_concurrency: 1 },
  },
};

async function connect(approvals: ApprovalService = new DenyAllApprovals(), failCreates = false) {
  const requests: NsRequest[] = [];
  let nextId = 9000;
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
      if (req.method === "POST" && req.path === "/services/rest/record/v1/customer") {
        if (failCreates) throw new Error("NetSuite rejected the record");
        return { location: `https://x/services/rest/record/v1/customer/${++nextId}` } as T;
      }
      if (req.method !== "POST" && req.method !== "GET") throw new Error(`unexpected ${req.method}`);
      const q = (req.body as { q: string }).q;
      if (q.includes("FROM subsidiary")) {
        return { items: [{ id: "1", name: "US West" }], hasMore: false, count: 1, offset: 0, totalResults: 1 } as T;
      }
      if (q.includes("FROM customer t WHERE t.companyname IN")) {
        return { items: [], hasMore: false, count: 0, offset: 0, totalResults: 0 } as T;
      }
      throw new Error(`unexpected query ${q}`);
    },
  };
  const { server } = createGateway({
    ns,
    skills: [skill],
    audit: new MemoryAuditSink(),
    approvals,
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

const RUN = {
  file: "valid.csv",
  recordType: "customer",
  mapping: { "Company Name": "companyName", "Tax Number": "vatRegNumber", Subsidiary: "subsidiary" },
  keyField: "companyName",
  fileSha256: sha(VALID),
};
const creates = (requests: NsRequest[]) => requests.filter((r) => r.method === "POST" && r.path === "/services/rest/record/v1/customer");

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

  describe("ns_import_run (ADR 0005)", () => {
    const approvals = () => new StoredApprovals({ store: new MemoryApprovalStore(), approvers: new Set(["doma"]) });

    it("dry run returns the file's sha256", async () => {
      const { call } = await connect();
      const res = await call("ns_import_dry_run", { file: "valid.csv", recordType: "customer", mapping: RUN.mapping });
      expect(res.json).toMatchObject({ fileSha256: sha(VALID), validRows: 2, invalidRows: 0 });
    });

    it("creates the records only after approval, exactly as dry-run", async () => {
      const a = approvals();
      const { call, requests } = await connect(a);
      const pending = await call("ns_import_run", RUN);
      expect(pending.json.status).toBe("approval_pending");
      expect(pending.json.preview).toMatch(/^Create 2 new customer records from valid\.csv \(sha256 [0-9a-f]{12}\)/);
      expect(creates(requests)).toHaveLength(0);

      await a.decide(pending.json.approvalId, { approver: "doma", approve: true });
      const res = await call("ns_import_run", { ...RUN, approvalId: pending.json.approvalId });
      expect(res.json).toMatchObject({ rowCount: 2, created: 2, failed: 0, notAttempted: 0, createdIds: ["9001", "9002"] });
      expect(creates(requests).map((r) => r.body)).toEqual([
        { companyName: "Acme", vatRegNumber: 123, subsidiary: { id: "1" } },
        { companyName: "Beta", vatRegNumber: 456, subsidiary: { id: "1" } },
      ]);
      expect(readFileSync(res.json.resultFile, "utf8")).toContain("2,created,9001,");

      const again = await call("ns_import_run", { ...RUN, approvalId: pending.json.approvalId });
      expect(again.text).toMatch(/already used/);
      expect(creates(requests)).toHaveLength(2);
    });

    it("refuses when the file changed after approval, creating nothing", async () => {
      const a = approvals();
      const { call, requests } = await connect(a);
      const pending = await call("ns_import_run", RUN);
      await a.decide(pending.json.approvalId, { approver: "doma", approve: true });
      writeFileSync(path.join(dir, "imports", "valid.csv"), VALID + "Gamma,789,1\n");
      try {
        const res = await call("ns_import_run", { ...RUN, approvalId: pending.json.approvalId });
        expect(res.isError).toBe(true);
        expect(res.text).toMatch(/changed since it was dry-run/);
        expect(creates(requests)).toHaveLength(0);
      } finally {
        writeFileSync(path.join(dir, "imports", "valid.csv"), VALID);
      }
    });

    it("will not even request approval for a file with invalid rows, the wrong hash or another record type", async () => {
      const { call, requests } = await connect(approvals());
      const bad = await call("ns_import_run", { ...RUN, file: "customers.csv", fileSha256: sha(readFileSync(path.join(dir, "imports", "customers.csv"), "utf8")) });
      expect(bad.text).toMatch(/rows fail the dry run/);
      expect((await call("ns_import_run", { ...RUN, fileSha256: "0".repeat(64) })).text).toMatch(/changed since it was dry-run/);
      expect((await call("ns_import_run", { ...RUN, recordType: "vendor" })).text).toMatch(/importing vendor records is not enabled/);
      expect(creates(requests)).toHaveLength(0);
    });

    it("stops after 5 consecutive failures and reports the rest as not attempted", async () => {
      const a = approvals();
      const { call, requests } = await connect(a, true);
      const args = { file: "five.csv", recordType: "customer", mapping: { "Company Name": "companyName", Subsidiary: "subsidiary" }, fileSha256: sha(readFileSync(path.join(dir, "imports", "five.csv"), "utf8")) };
      const pending = await call("ns_import_run", args);
      await a.decide(pending.json.approvalId, { approver: "doma", approve: true });
      const res = await call("ns_import_run", { ...args, approvalId: pending.json.approvalId });
      expect(res.json).toMatchObject({ rowCount: 7, created: 0, failed: 5, notAttempted: 2, stoppedEarly: true });
      expect(creates(requests)).toHaveLength(5);
    });

    it("is refused outright while writes are off", async () => {
      const { call, requests } = await connect(new DenyAllApprovals());
      const res = await call("ns_import_run", RUN);
      expect(res.text).toMatch(/not enabled/);
      expect(creates(requests)).toHaveLength(0);
    });
  });
});
