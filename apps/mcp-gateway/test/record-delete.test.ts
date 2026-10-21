import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NsRequest, NsRequester } from "@ns-agent/ns-client";
import { describe, expect, it } from "vitest";
import {
  DenyAllApprovals,
  MemoryApprovalStore,
  MemoryAuditSink,
  StoredApprovals,
  createGateway,
  type ApprovalService,
  type LoadedSkill,
} from "../src";

const skill: LoadedSkill = {
  dir: "/skills/data-importer",
  body: "",
  manifest: {
    name: "data-importer",
    description: "test skill description that is long enough to pass validation",
    version: "3.0.0",
    owner: "@t",
    tools: ["ns_record_delete_preview", "ns_record_delete"],
    writes: true,
    enabled: true,
    platform: false,
    deprecated: false,
    governance_budget: { max_calls_per_invocation: 10, max_concurrency: 1 },
  },
};

function fakeNs() {
  const records = new Map([
    ["2828", { id: "2828", entityid: "CUST-2828", companyname: "NS Agent CP3 Test Customer 1", externalid: "nsagent-cp3-test-001", lastmodified: "2026-10-21 12:57:16" }],
    ["2829", { id: "2829", entityid: "CUST-2829", companyname: "NS Agent CP3 Test Customer 2", externalid: "nsagent-cp3-test-002", lastmodified: "2026-10-21 12:57:17" }],
  ]);
  const requests: NsRequest[] = [];
  const ns: NsRequester = {
    async request<T>(req: NsRequest): Promise<T> {
      requests.push(req);
      if (req.method === "DELETE") {
        const id = req.path.split("/").at(-1)!;
        records.delete(id);
        return undefined as T;
      }
      const q = (req.body as { q: string }).q;
      const ids = [...q.matchAll(/\d{4}/g)].map((m) => m[0]);
      const items = ids.map((id) => records.get(id)).filter(Boolean);
      return { items, hasMore: false, count: items.length, offset: 0, totalResults: items.length } as T;
    },
  };
  return { ns, requests, records };
}

async function connect(approvals: ApprovalService = new DenyAllApprovals()) {
  const fake = fakeNs();
  const audit = new MemoryAuditSink();
  const { server } = createGateway({
    ns: fake.ns,
    skills: [skill],
    audit,
    approvals,
    redactFields: new Set(),
    accountId: "TSTDRV1755417",
    requestedBy: "doma",
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
  return { call, audit, ...fake };
}

const deletes = (requests: NsRequest[]) => requests.filter((r) => r.method === "DELETE");

describe("approved deletes (ADR 0006)", () => {
  it("previews the records and a snapshot of their last-modified times, reading only", async () => {
    const { call, requests } = await connect();
    const res = await call("ns_record_delete_preview", { recordType: "customer", ids: ["2828", "2829"] });
    expect(res.json).toMatchObject({
      recordType: "customer",
      missing: [],
      records: [
        { id: "2828", name: "NS Agent CP3 Test Customer 1", externalId: "nsagent-cp3-test-001", lastModified: "2026-10-21 12:57:16" },
        { id: "2829", name: "NS Agent CP3 Test Customer 2", externalId: "nsagent-cp3-test-002", lastModified: "2026-10-21 12:57:17" },
      ],
    });
    expect(res.json.snapshot).toMatch(/^[0-9a-f]{64}$/);
    expect(requests.every((r) => r.method === "POST" && r.path === "/services/rest/query/v1/suiteql")).toBe(true);
  });

  it("deletes exactly the approved records once", async () => {
    const approvals = new StoredApprovals({ store: new MemoryApprovalStore(), approvers: new Set(["doma"]) });
    const { call, requests, records, audit } = await connect(approvals);
    const { snapshot } = (await call("ns_record_delete_preview", { recordType: "customer", ids: ["2828", "2829"] })).json;
    const args = { recordType: "customer", ids: ["2828", "2829"], snapshot };
    const pending = await call("ns_record_delete", args);
    expect(pending.json.status).toBe("approval_pending");
    expect(pending.json.preview).toMatch(/^Permanently delete 2 customer records: 2828 "NS Agent CP3 Test Customer 1" \(external id nsagent-cp3-test-001/);
    expect(pending.json.preview).toMatch(/This cannot be undone\.$/);
    expect(deletes(requests)).toHaveLength(0);

    await approvals.decide(pending.json.approvalId, { approver: "doma", approve: true });
    const res = await call("ns_record_delete", { ...args, approvalId: pending.json.approvalId });
    expect(res.json).toMatchObject({ requested: 2, deleted: 2, failed: 0, deletedIds: ["2828", "2829"] });
    expect(deletes(requests).map((r) => r.path)).toEqual([
      "/services/rest/record/v1/customer/2828",
      "/services/rest/record/v1/customer/2829",
    ]);
    expect(records.size).toBe(0);
    expect(audit.entries.at(-1)).toMatchObject({ event: "tool.call", ok: true, approvedBy: "doma", writes: true });

    const again = await call("ns_record_delete", { ...args, approvalId: pending.json.approvalId });
    expect(again.text).toMatch(/already used/);
    expect(deletes(requests)).toHaveLength(2);
  });

  it("refuses when a record changed after approval, deleting nothing", async () => {
    const approvals = new StoredApprovals({ store: new MemoryApprovalStore(), approvers: new Set(["doma"]) });
    const { call, requests, records } = await connect(approvals);
    const { snapshot } = (await call("ns_record_delete_preview", { recordType: "customer", ids: ["2828"] })).json;
    const pending = await call("ns_record_delete", { recordType: "customer", ids: ["2828"], snapshot });
    await approvals.decide(pending.json.approvalId, { approver: "doma", approve: true });
    records.get("2828")!.lastmodified = "2026-10-21 13:05:00";
    const res = await call("ns_record_delete", { recordType: "customer", ids: ["2828"], snapshot, approvalId: pending.json.approvalId });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/changed since the preview/);
    expect(deletes(requests)).toHaveLength(0);
  });

  it("will not request approval for missing ids, duplicates, a stale snapshot or another record type", async () => {
    const { call, requests } = await connect(new StoredApprovals({ store: new MemoryApprovalStore(), approvers: new Set(["doma"]) }));
    const { snapshot } = (await call("ns_record_delete_preview", { recordType: "customer", ids: ["2828"] })).json;
    expect((await call("ns_record_delete", { recordType: "customer", ids: ["2828", "9999"], snapshot })).text).toMatch(/not found: 9999/);
    expect((await call("ns_record_delete", { recordType: "customer", ids: ["2828", "2828"], snapshot })).text).toMatch(/listed twice/);
    expect((await call("ns_record_delete", { recordType: "customer", ids: ["2829"], snapshot })).text).toMatch(/changed since the preview/);
    expect((await call("ns_record_delete", { recordType: "vendor", ids: ["2828"], snapshot })).text).toMatch(/deleting vendor records is not enabled/);
    expect(deletes(requests)).toHaveLength(0);
  });

  it("is refused outright while writes are off", async () => {
    const { call, requests } = await connect();
    const res = await call("ns_record_delete", { recordType: "customer", ids: ["2828"], snapshot: "0".repeat(64) });
    expect(res.text).toMatch(/not enabled/);
    expect(requests).toHaveLength(0);
  });
});
