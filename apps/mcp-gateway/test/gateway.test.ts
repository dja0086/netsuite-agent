import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NsRequest, NsRequester } from "@ns-agent/ns-client";
import { NsHttpError } from "@ns-agent/ns-client";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ALL_TOOLS,
  DenyAllApprovals,
  MemoryApprovalStore,
  MemoryAuditSink,
  StoredApprovals,
  type ApprovalService,
  createGateway,
  defineTool,
  type LoadedSkill,
  type ToolDef,
} from "../src";

function skill(name: string, tools: string[], extra: Partial<LoadedSkill["manifest"]> = {}): LoadedSkill {
  return {
    dir: `/skills/${name}`,
    body: "",
    manifest: {
      name,
      description: "test skill description that is long enough to pass validation",
      version: "1.0.0",
      owner: "@t",
      tools,
      writes: false,
      enabled: true,
      platform: false,
      deprecated: false,
      governance_budget: { max_calls_per_invocation: 10, max_concurrency: 1 },
      ...extra,
    },
  };
}

/** Fake NetSuite answering the few endpoints the data tools use. */
function fakeNs(): NsRequester & { requests: NsRequest[] } {
  const requests: NsRequest[] = [];
  return {
    requests,
    async request<T>(req: NsRequest): Promise<T> {
      requests.push(req);
      if (req.path === "/services/rest/query/v1/suiteql") {
        const q = (req.body as { q: string }).q;
        if (q.includes("nosuchtable")) throw new NsHttpError(400, "INVALID_PARAMETER", "Invalid search query.");
        return {
          items: [{ id: 1, companyname: "Acme", taxidnum: "12-3456789", links: [] }],
          hasMore: false,
          count: 1,
          offset: 0,
          totalResults: 1,
        } as T;
      }
      if (req.path === "/services/rest/record/v1/metadata-catalog") {
        return { items: [{ name: "customer" }, { name: "salesorder" }, { name: "customrecord_widget" }] } as T;
      }
      if (req.path === "/services/rest/record/v1/metadata-catalog/customer") {
        return {
          properties: {
            companyname: { title: "Company Name", type: "string" },
            custentity_tier: { title: "Tier", type: "object", nullable: true },
          },
        } as T;
      }
      if (req.base === "restlet") return { results: [{ type: "customer", id: "1", name: "Acme" }] } as T;
      throw new Error(`unexpected ${req.path}`);
    },
  };
}

async function connect(options: { skills: LoadedSkill[]; tools?: ToolDef[]; redact?: string[]; approvals?: ApprovalService }) {
  const ns = fakeNs();
  const audit = new MemoryAuditSink();
  const { server, exposed } = createGateway({
    ns,
    skills: options.skills,
    tools: options.tools,
    audit,
    approvals: options.approvals ?? new DenyAllApprovals(),
    redactFields: new Set(options.redact ?? []),
    accountId: "TSTDRV1755417",
    requestedBy: "doma",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    return { isError: Boolean(res.isError), text, json: res.isError ? undefined : JSON.parse(text) };
  };
  return { client, call, ns, audit, exposed };
}

const DATA_TOOLS = ["ns_catalog_list", "ns_record_describe", "ns_suiteql", "ns_record_get", "ns_global_search"];

describe("gateway", () => {
  it("serves only tools declared by enabled skills", async () => {
    const { client, exposed } = await connect({ skills: [skill("data-explorer", ["ns_suiteql"])] });
    expect(exposed).toEqual(["ns_suiteql"]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["ns_suiteql"]);
    expect(tools[0]!.annotations?.readOnlyHint).toBe(true);
  });

  it("refuses to start when a skill declares an unknown tool", () => {
    expect(() =>
      createGateway({
        ns: fakeNs(),
        skills: [skill("x", ["ns_does_not_exist"])],
        audit: new MemoryAuditSink(),
        approvals: new DenyAllApprovals(),
        redactFields: new Set(),
        accountId: "TSTDRV1755417",
      }),
    ).toThrow(/ns_does_not_exist/);
  });

  it("runs SuiteQL, strips links and redacts configured fields", async () => {
    const { call, audit } = await connect({ skills: [skill("data-explorer", DATA_TOOLS)], redact: ["taxidnum"] });
    const res = await call("ns_suiteql", { q: "SELECT id, companyname, taxidnum FROM customer" });
    expect(res.isError).toBe(false);
    expect(res.json.rows).toEqual([{ id: 1, companyname: "Acme", taxidnum: "[REDACTED]" }]);
    expect(audit.entries[0]).toMatchObject({ tool: "ns_suiteql", ok: true, rowCount: 1 });
    expect(audit.entries[0]!.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(audit.entries)).not.toContain("SELECT");
  });

  it("rejects non-SELECT SuiteQL before it reaches NetSuite", async () => {
    const { call, ns, audit } = await connect({ skills: [skill("data-explorer", DATA_TOOLS)] });
    const res = await call("ns_suiteql", { q: "DELETE FROM customer WHERE id = 1" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Only SELECT/);
    expect(ns.requests).toHaveLength(0);
    expect(audit.entries[0]).toMatchObject({ ok: false, errorCode: "INVALID_INPUT" });
  });

  it("passes NetSuite error codes to the model without the raw body", async () => {
    const { call } = await connect({ skills: [skill("data-explorer", DATA_TOOLS)] });
    const res = await call("ns_suiteql", { q: "SELECT id FROM nosuchtable" });
    expect(res.isError).toBe(true);
    expect(res.text).toBe("NetSuite rejected the request (INVALID_PARAMETER): Invalid search query.");
  });

  it("lists and describes record types through the metadata cache", async () => {
    const { call, ns } = await connect({ skills: [skill("data-explorer", DATA_TOOLS)] });
    expect((await call("ns_catalog_list", { filter: "CustomRecord" })).json).toEqual({
      count: 1,
      recordTypes: ["customrecord_widget"],
    });
    const described = await call("ns_record_describe", { type: "customer", customOnly: true });
    expect(described.json.fields).toEqual([
      { id: "custentity_tier", label: "Tier", type: "object", nullable: true, custom: true },
    ]);
    // filter matches the field id or the label, case-insensitively, and reports the full count
    expect((await call("ns_record_describe", { type: "customer", filter: "COMPANY" })).json).toMatchObject({
      fieldCount: 1,
      totalFieldCount: 2,
      fields: [{ id: "companyname" }],
    });
    expect((await call("ns_record_describe", { type: "customer", filter: "tier" })).json.fields).toHaveLength(1);
    await call("ns_record_describe", { type: "customer" });
    expect(ns.requests.filter((r) => r.path.endsWith("/customer"))).toHaveLength(1);
  });

  it("calls the explore RESTlet for global search", async () => {
    const { call, ns } = await connect({ skills: [skill("data-explorer", DATA_TOOLS)] });
    const res = await call("ns_global_search", { keywords: "cu: acme" });
    expect(res.json.results[0].name).toBe("Acme");
    expect(ns.requests[0]).toMatchObject({ base: "restlet", body: { action: "globalSearch", keywords: "cu: acme", limit: 20 } });
  });

  it("blocks write tools without approval and never runs their handler", async () => {
    let ran = false;
    const writeTool = defineTool({
      name: "ns_test_write",
      title: "Test write",
      description: "test",
      writes: true,
      input: z.object({ value: z.string() }),
      async describeChange({ value }) {
        return `Write ${value}`;
      },
      async handler() {
        ran = true;
        return { ok: true };
      },
    });
    const { call, audit, client } = await connect({
      skills: [skill("writer", ["ns_test_write"], { writes: true })],
      tools: [...ALL_TOOLS, writeTool as unknown as ToolDef],
    });
    const { tools } = await client.listTools();
    expect(tools[0]!.annotations?.destructiveHint).toBe(true);
    const res = await call("ns_test_write", { value: "x" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/writes are not enabled/);
    expect(ran).toBe(false);
    expect(audit.entries[0]).toMatchObject({ writes: true, ok: false, errorCode: "APPROVAL_DENIED" });
  });

  describe("approval flow (ADR 0004)", () => {
    function writer() {
      const runs: string[] = [];
      const tool = defineTool({
        name: "ns_test_write",
        title: "Test write",
        description: "test",
        writes: true,
        input: z.object({ value: z.string() }),
        async describeChange({ value }) {
          return `Set value to '${value}'`;
        },
        async handler({ value }) {
          runs.push(value);
          return { saved: value };
        },
      });
      return { runs, tool: tool as unknown as ToolDef };
    }

    async function setupFlow() {
      const { runs, tool } = writer();
      const approvals = new StoredApprovals({ store: new MemoryApprovalStore(), approvers: new Set(["doma"]) });
      const conn = await connect({
        skills: [skill("writer", ["ns_test_write"], { writes: true })],
        tools: [...ALL_TOOLS, tool],
        approvals,
      });
      return { ...conn, runs, approvals };
    }

    it("first call returns a pending approval with the preview and runs nothing", async () => {
      const { call, runs, audit, approvals } = await setupFlow();
      const res = await call("ns_test_write", { value: "x" });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ status: "approval_pending", preview: "Set value to 'x'" });
      expect(runs).toEqual([]);
      const stored = await approvals.get(res.json.approvalId);
      expect(stored).toMatchObject({ status: "pending", tool: "ns_test_write", accountId: "TSTDRV1755417", requestedBy: "doma" });
      expect(audit.entries[0]).toMatchObject({ event: "approval.requested", approvalId: res.json.approvalId, ok: true });
      expect(audit.entries[0]!.inputHash).toBe(stored!.payloadHash);
    });

    it("runs once after approval and audits approvalId and approver", async () => {
      const { call, runs, audit, approvals } = await setupFlow();
      const { approvalId } = (await call("ns_test_write", { value: "x" })).json;
      await approvals.decide(approvalId, { approver: "doma", approve: true });
      const res = await call("ns_test_write", { value: "x", approvalId });
      expect(res.json).toEqual({ saved: "x" });
      expect(runs).toEqual(["x"]);
      expect(audit.entries.at(-1)).toMatchObject({ event: "tool.call", ok: true, approvalId, approvedBy: "doma", writes: true });
      expect((await approvals.get(approvalId))?.status).toBe("executed");

      const again = await call("ns_test_write", { value: "x", approvalId });
      expect(again.isError).toBe(true);
      expect(again.text).toMatch(/already used/);
      expect(runs).toEqual(["x"]);
      expect(audit.entries.at(-1)).toMatchObject({ event: "approval.rejected", errorCode: "APPROVAL_INVALID", approvalId });
    });

    it("refuses an approval presented with a changed payload", async () => {
      const { call, runs, approvals } = await setupFlow();
      const { approvalId } = (await call("ns_test_write", { value: "x" })).json;
      await approvals.decide(approvalId, { approver: "doma", approve: true });
      const res = await call("ns_test_write", { value: "y", approvalId });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/payload changed/);
      expect(runs).toEqual([]);
    });

    it("tells the agent when the approval is still pending", async () => {
      const { call, runs } = await setupFlow();
      const { approvalId } = (await call("ns_test_write", { value: "x" })).json;
      const res = await call("ns_test_write", { value: "x", approvalId });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/not been approved yet/);
      expect(runs).toEqual([]);
    });

    it("marks the approval failed when the write fails", async () => {
      const approvals = new StoredApprovals({ store: new MemoryApprovalStore(), approvers: new Set(["doma"]) });
      const failing = defineTool({
        name: "ns_test_write",
        title: "Test write",
        description: "test",
        writes: true,
        input: z.object({ value: z.string() }),
        async describeChange() {
          return "p";
        },
        async handler(): Promise<unknown> {
          throw new NsHttpError(400, "INVALID_FLD_VALUE", "bad");
        },
      });
      const { call } = await connect({
        skills: [skill("writer", ["ns_test_write"], { writes: true })],
        tools: [...ALL_TOOLS, failing as unknown as ToolDef],
        approvals,
      });
      const { approvalId } = (await call("ns_test_write", { value: "x" })).json;
      await approvals.decide(approvalId, { approver: "doma", approve: true });
      expect((await call("ns_test_write", { value: "x", approvalId })).isError).toBe(true);
      expect((await approvals.get(approvalId))?.status).toBe("failed");
    });

    it("adds approvalId to write tool schemas only", async () => {
      const { client } = await setupFlow();
      const { tools } = await client.listTools();
      expect(Object.keys(tools[0]!.inputSchema.properties ?? {})).toEqual(["value", "approvalId"]);
    });

    it("refuses to start when a write tool has no describeChange", () => {
      const bare = defineTool({
        name: "ns_test_write",
        title: "t",
        description: "t",
        writes: true,
        input: z.object({}),
        async handler() {
          return {};
        },
      });
      expect(() =>
        createGateway({
          ns: fakeNs(),
          skills: [skill("writer", ["ns_test_write"], { writes: true })],
          tools: [...ALL_TOOLS, bare as unknown as ToolDef],
          audit: new MemoryAuditSink(),
          approvals: new DenyAllApprovals(),
          redactFields: new Set(),
          accountId: "TSTDRV1755417",
        }),
      ).toThrow(/describeChange/);
    });
  });

  it("validates tool input with the declared schema", async () => {
    const { call, ns } = await connect({ skills: [skill("data-explorer", DATA_TOOLS)] });
    const res = await call("ns_record_get", { type: "customer", id: "../../etc" });
    expect(res.isError).toBe(true);
    expect(ns.requests).toHaveLength(0);
  });
});
