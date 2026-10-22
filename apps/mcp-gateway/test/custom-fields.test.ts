import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NsRequest, NsRequester } from "@ns-agent/ns-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DenyAllApprovals, MemoryAuditSink, createGateway, type LoadedSkill } from "../src";

const skill: LoadedSkill = {
  dir: "/skills/custom-fields",
  body: "",
  manifest: {
    name: "custom-fields",
    description: "test skill description that is long enough to pass validation",
    version: "0.1.0",
    owner: "@t",
    tools: ["ns_field_plan", "ns_field_generate"],
    writes: false,
    enabled: true,
    platform: false,
    deprecated: false,
    governance_budget: { max_calls_per_invocation: 10, max_concurrency: 1 },
  },
};

const MANIFEST = `<manifest projecttype="ACCOUNTCUSTOMIZATION">
  <dependencies>
    <features>
      <feature required="true">SERVERSIDESCRIPTING</feature>
    </features>
  </dependencies>
</manifest>
`;

/** Metadata per record type; a type missing here answers 404 like an unreadable catalog entry. */
function fakeNs(fields: Record<string, Record<string, string>>) {
  const requests: NsRequest[] = [];
  const ns: NsRequester = {
    async request<T>(req: NsRequest): Promise<T> {
      requests.push(req);
      if (req.method !== "GET" || !req.path.includes("/metadata-catalog/")) throw new Error(`unexpected ${req.method} ${req.path}`);
      const type = req.path.split("/").at(-1)!;
      const props = fields[type];
      if (!props) throw new Error(`Record type ${type} not found`);
      return { properties: Object.fromEntries(Object.entries(props).map(([id, title]) => [id, { title, type: "string" }])) } as T;
    },
  };
  return { ns, requests };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sdf-"));
  await mkdir(path.join(dir, "Objects"));
  await writeFile(path.join(dir, "manifest.xml"), MANIFEST);
  process.env.NS_AGENT_SDF_DIR = dir;
});
afterEach(() => {
  delete process.env.NS_AGENT_SDF_DIR;
});

async function connect(fields: Record<string, Record<string, string>> = { salesorder: {}, invoice: {}, customer: {}, inventoryitem: {} }) {
  const fake = fakeNs(fields);
  const { server } = createGateway({
    ns: fake.ns,
    skills: [skill],
    audit: new MemoryAuditSink(),
    approvals: new DenyAllApprovals(),
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
    return { isError: Boolean(res.isError), text, json: res.isError ? undefined : (JSON.parse(text) as Record<string, unknown>) };
  };
  return { client, call, requests: fake.requests };
}

const RUSH = { kind: "body", name: "rush", label: "Rush order", type: "CHECKBOX", appliesTo: ["sale"] };

describe("ns_field_plan", () => {
  it("returns the XML and checks the record types the field applies to, writing nothing", async () => {
    const { call, requests } = await connect();
    const r = await call("ns_field_plan", RUSH);
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      scriptId: "custbody_nsagent_rush",
      path: "Objects/fields/custbody_nsagent_rush.xml",
      features: [],
      inSdfProject: false,
      checkedRecordTypes: expect.arrayContaining(["salesorder", "invoice"]),
      uncheckedRecordTypes: [],
      collisions: [],
      ready: true,
    });
    expect(r.json!.xml).toContain('<transactionbodycustomfield scriptid="custbody_nsagent_rush">');
    expect(requests.every((q) => q.method === "GET")).toBe(true);
    expect(await readdir(path.join(dir, "Objects"))).toEqual([]);
  });

  it("reports a script ID clash, a label clash and record types it could not read", async () => {
    const { call } = await connect({
      salesorder: { custbody_nsagent_rush: "Rush", custbody_other: "Rush order" },
      invoice: {},
    });
    const r = await call("ns_field_plan", { ...RUSH, appliesTo: ["sale", "purchase", "expensereport"] });
    expect(r.json).toMatchObject({
      ready: false,
      collisions: [{ recordType: "salesorder", fieldId: "custbody_nsagent_rush", label: "Rush" }],
    });
    const unchecked = (r.json!.uncheckedRecordTypes as Array<{ recordType: string }>).map((u) => u.recordType).sort();
    expect(unchecked).toEqual(["expensereport", "purchaseorder", "vendorbill"]);
    expect((r.json!.warnings as string[]).join("\n")).toMatch(/custbody_other/);
  });

  it("turns spec errors into input errors", async () => {
    const { call } = await connect();
    const r = await call("ns_field_plan", { ...RUSH, name: "preferred_delivery_window" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("at most 21 characters");
  });

  it("is read-only to MCP clients, while generate is not", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const hint = (n: string) => tools.find((t) => t.name === n)!.annotations;
    expect(hint("ns_field_plan")).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(hint("ns_field_generate")).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});

describe("ns_field_generate", () => {
  it("writes the field and adds the manifest features it needs", async () => {
    const { call } = await connect();
    const r = await call("ns_field_generate", { kind: "item", name: "hazmat_class", label: "Hazmat class", type: "TEXT", appliesTo: ["inventory"] });
    expect(r.json).toMatchObject({
      scriptId: "custitem_nsagent_hazmat_class",
      replaced: false,
      written: ["Objects/fields/custitem_nsagent_hazmat_class.xml", "manifest.xml"],
      manifestFeaturesAdded: ["INVENTORY"],
    });
    expect(await readFile(path.join(dir, "Objects/fields/custitem_nsagent_hazmat_class.xml"), "utf8")).toContain("<appliestoinventory>T</appliestoinventory>");
    expect(await readFile(path.join(dir, "manifest.xml"), "utf8")).toContain('<feature required="true">INVENTORY</feature>');
  });

  it("refuses to overwrite unless replace is true, then replaces", async () => {
    const { call } = await connect();
    await call("ns_field_generate", RUSH);
    const again = await call("ns_field_generate", { ...RUSH, label: "Rush (same day)" });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("already in the SDF project");
    const replaced = await call("ns_field_generate", { ...RUSH, label: "Rush (same day)", replace: true });
    expect(replaced.json).toMatchObject({ replaced: true, written: ["Objects/fields/custbody_nsagent_rush.xml"] });
    expect(await readFile(path.join(dir, "Objects/fields/custbody_nsagent_rush.xml"), "utf8")).toContain("<label>Rush (same day)</label>");
  });

  it("refuses a script ID that exists in NetSuite but not in the project", async () => {
    const { call } = await connect({ salesorder: { custbody_nsagent_rush: "Rush" }, invoice: {} });
    const r = await call("ns_field_generate", { ...RUSH, replace: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("already exists in NetSuite and is not in the SDF project");
    expect(await readdir(path.join(dir, "Objects"))).toEqual([]);
  });

  it("refuses when the SDF project folder is missing", async () => {
    process.env.NS_AGENT_SDF_DIR = path.join(dir, "nope");
    const { call } = await connect();
    const r = await call("ns_field_generate", RUSH);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("NS_AGENT_SDF_DIR");
  });
});
