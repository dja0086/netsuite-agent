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
  dir: "/skills/search-builder",
  body: "",
  manifest: {
    name: "search-builder",
    description: "test skill description that is long enough to pass validation",
    version: "0.1.0",
    owner: "@t",
    tools: ["ns_search_preview", "ns_search_save"],
    writes: true,
    enabled: true,
    platform: false,
    deprecated: false,
    governance_budget: { max_calls_per_invocation: 10, max_concurrency: 1 },
  },
};

function fakeNs(): NsRequester & { bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  return {
    bodies,
    async request<T>(req: NsRequest): Promise<T> {
      const body = req.body as Record<string, unknown>;
      bodies.push(body);
      if (body.action === "preview") {
        return { recordType: body.recordType, totalCount: 42, columns: ["tranid"], rows: [{ tranid: "INV1" }] } as T;
      }
      if (body.action === "save") return { saved: true, internalId: "901", scriptId: body.scriptId } as T;
      throw new Error("unexpected");
    },
  };
}

async function connect(approvals: ApprovalService = new DenyAllApprovals()) {
  const ns = fakeNs();
  const audit = new MemoryAuditSink();
  const { server } = createGateway({
    ns,
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
  return { call, ns, audit };
}

const SPEC = {
  recordType: "transaction",
  filters: [{ field: "type", operator: "anyof", values: ["CustInvc"] }],
  columns: [{ field: "tranid" }, { field: "duedate", sort: "asc" }],
};

describe("search-builder tools", () => {
  it("previews through the search RESTlet", async () => {
    const { call, ns } = await connect();
    const res = await call("ns_search_preview", { ...SPEC, limit: 5 });
    expect(res.json).toMatchObject({ totalCount: 42, rowCount: 1 });
    expect(ns.bodies[0]).toMatchObject({ action: "preview", recordType: "transaction", limit: 5 });
  });

  it("rejects unknown operators and unsafe field ids before calling NetSuite", async () => {
    const { call, ns } = await connect();
    const op = await call("ns_search_preview", { ...SPEC, filters: [{ field: "type", operator: "drop", values: [] }] });
    expect(op.isError).toBe(true);
    expect(op.text).toMatch(/operator/);
    const field = await call("ns_search_preview", { ...SPEC, columns: [{ field: "tranid; drop" }] });
    expect(field.isError).toBe(true);
    expect(field.text).toMatch(/field/);
    expect(ns.bodies).toHaveLength(0);
  });

  it("refuses to save without approvals enabled", async () => {
    const { call, ns } = await connect();
    const res = await call("ns_search_save", { ...SPEC, title: "Open AR", scriptIdSuffix: "open_ar" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not enabled/);
    expect(ns.bodies.some((b) => b.action === "save")).toBe(false);
  });

  it("saves only after approval, with the conventional script id", async () => {
    const approvals = new StoredApprovals({ store: new MemoryApprovalStore(), approvers: new Set(["doma"]) });
    const { call, ns } = await connect(approvals);
    const args = { ...SPEC, title: "Open AR", scriptIdSuffix: "open_ar" };
    const pending = await call("ns_search_save", args);
    expect(pending.json.status).toBe("approval_pending");
    expect(pending.json.preview).toBe(
      'Save private saved search "Open AR" as customsearch_nsagent_open_ar on transaction. ' +
        'Filters: type anyof "CustInvc". Columns: tranid, duedate asc. It currently matches 42 results.',
    );
    expect(ns.bodies.map((b) => b.action)).toEqual(["preview"]);

    await approvals.decide(pending.json.approvalId, { approver: "doma", approve: true });
    const saved = await call("ns_search_save", { ...args, approvalId: pending.json.approvalId });
    expect(saved.json).toMatchObject({ saved: true, scriptId: "customsearch_nsagent_open_ar" });
    expect(ns.bodies.filter((b) => b.action === "save")).toHaveLength(1);
  });
});
