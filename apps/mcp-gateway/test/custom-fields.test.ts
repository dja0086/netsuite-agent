import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

/**
 * Fake account: `fields` is REST metadata per record type (a missing type answers like an unreadable catalog entry);
 * `columns` is the custom fields each SuiteQL table exposes (a missing table answers like one the role cannot query).
 */
interface FakeAccount {
  fields?: Record<string, Record<string, string>>;
  columns?: Record<string, string[]>;
}
const OPEN_TABLES = { transaction: [], item: [], customer: [], vendor: [], contact: [], employee: [], partner: [], job: [] };

function fakeNs({ fields = {}, columns = OPEN_TABLES }: FakeAccount) {
  const requests: NsRequest[] = [];
  const ns: NsRequester = {
    async request<T>(req: NsRequest): Promise<T> {
      requests.push(req);
      if (req.method === "POST" && req.path.endsWith("/suiteql")) {
        const q = (req.body as { q: string }).q;
        const table = /FROM (\w+) t/.exec(q)![1]!;
        const cols = (columns as Record<string, string[]>)[table];
        if (!cols) throw new Error(`Record '${table}' was not found.`);
        const field = /WHERE t\.(\w+) IS NOT NULL/.exec(q)?.[1];
        if (field && !cols.includes(field)) throw new Error("An unexpected error occurred.");
        return { items: [{ n: "0" }], hasMore: false, count: 1, offset: 0, totalResults: 1 } as T;
      }
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

const ALL_TYPES = { salesorder: {}, invoice: {}, purchaseorder: {}, vendorbill: {}, customer: {}, vendor: {}, inventoryitem: {} };

async function connect(account: FakeAccount = { fields: ALL_TYPES }) {
  const fake = fakeNs({ fields: ALL_TYPES, ...account });
  const audit = new MemoryAuditSink();
  const { server } = createGateway({
    ns: fake.ns,
    skills: [skill],
    audit,
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
  return { client, call, audit, requests: fake.requests };
}

const RUSH = { kind: "body", name: "rush", label: "Rush order", type: "CHECKBOX", appliesTo: ["sale"] };

describe("ns_field_plan", () => {
  it("returns the XML, proves the ID unused account-wide and checks labels where the field shows, writing nothing", async () => {
    const { call, requests } = await connect();
    const r = await call("ns_field_plan", RUSH);
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      scriptId: "custbody_nsagent_rush",
      path: "Objects/fields/custbody_nsagent_rush.xml",
      features: [],
      inSdfProject: false,
      scriptIdCheck: [{ table: "transaction", result: "absent" }],
      labelCheckedRecordTypes: ["invoice", "salesorder"],
      labelClashes: [],
      ready: true,
    });
    expect(r.json!.xml).toContain('<transactionbodycustomfield scriptid="custbody_nsagent_rush">');
    expect(requests.every((q) => q.method === "GET" || q.path.endsWith("/suiteql"))).toBe(true);
    expect(await readdir(path.join(dir, "Objects"))).toEqual([]);
  });

  it("finds an ID that exists on a record type the field would not apply to", async () => {
    // The field exists but only on purchases: the sales metadata does not list it, the transaction table does.
    const { call } = await connect({ columns: { ...OPEN_TABLES, transaction: ["custbody_nsagent_rush"] } });
    const r = await call("ns_field_plan", RUSH);
    expect(r.json).toMatchObject({ ready: false, scriptIdCheck: [{ table: "transaction", result: "exists" }] });
    expect((r.json!.warnings as string[]).join("\n")).toContain("already exists in NetSuite (found on transaction)");
  });

  it("probes every entity table and is not ready when one cannot be queried", async () => {
    const { partner, job, ...readable } = OPEN_TABLES;
    void partner;
    void job;
    const { call } = await connect({ columns: { ...readable, vendor: ["custentity_nsagent_tier"] } });
    const r = await call("ns_field_plan", { kind: "entity", name: "tier", label: "Tier", type: "TEXT", appliesTo: ["customer"] });
    const check = r.json!.scriptIdCheck as Array<{ table: string; result: string }>;
    expect(Object.fromEntries(check.map((c) => [c.table, c.result]))).toEqual({
      customer: "absent",
      vendor: "exists",
      contact: "absent",
      employee: "absent",
      partner: "unchecked",
      job: "unchecked",
    });
    expect(r.json!.ready).toBe(false);
  });

  it("reports a label clash and record types whose labels it could not read", async () => {
    const { call } = await connect({ fields: { salesorder: { custbody_other: "Rush order" }, invoice: {} } });
    const r = await call("ns_field_plan", { ...RUSH, appliesTo: ["sale", "purchase", "expensereport"] });
    expect(r.json!.labelClashes).toEqual([{ recordType: "salesorder", fieldId: "custbody_other", label: "Rush order" }]);
    const unchecked = (r.json!.labelUncheckedRecordTypes as Array<{ recordType: string }>).map((u) => u.recordType).sort();
    expect(unchecked).toEqual(["expensereport", "purchaseorder", "vendorbill"]);
    expect(r.json!.ready).toBe(true);
  });

  it("warns about mandatory fields", async () => {
    const { call } = await connect();
    const r = await call("ns_field_plan", { ...RUSH, type: "TEXT", mandatory: true });
    expect((r.json!.warnings as string[]).join("\n")).toMatch(/mandatory: every save .* ns_import_run/);
  });

  it("turns spec errors into input errors, including inherited applies-to keys", async () => {
    const { call } = await connect();
    const long = await call("ns_field_plan", { ...RUSH, name: "preferred_delivery_window" });
    expect(long.isError).toBe(true);
    expect(long.text).toContain("at most 21 characters");
    const proto = await call("ns_field_plan", { ...RUSH, appliesTo: ["constructor"] });
    expect(proto.isError).toBe(true);
    expect(proto.text).toContain("body fields apply to");
  });

  it("is read-only to MCP clients, while generate is not", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const hint = (n: string) => tools.find((t) => t.name === n)!.annotations;
    expect(hint("ns_field_plan")).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(hint("ns_field_generate")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});

describe("ns_field_generate", () => {
  it("writes the field, adds the manifest features it needs and audits the files", async () => {
    const { call, audit } = await connect();
    const r = await call("ns_field_generate", { kind: "item", name: "hazmat_class", label: "Hazmat class", type: "TEXT", appliesTo: ["inventory"] });
    expect(r.json).toMatchObject({
      scriptId: "custitem_nsagent_hazmat_class",
      replaced: false,
      written: ["Objects/fields/custitem_nsagent_hazmat_class.xml", "manifest.xml"],
      manifestFeaturesAdded: ["INVENTORY"],
    });
    expect(await readFile(path.join(dir, "Objects/fields/custitem_nsagent_hazmat_class.xml"), "utf8")).toContain("<appliestoinventory>T</appliestoinventory>");
    expect(await readFile(path.join(dir, "manifest.xml"), "utf8")).toContain('<feature required="true">INVENTORY</feature>');
    expect(audit.entries.at(-1)).toMatchObject({
      tool: "ns_field_generate",
      writes: false,
      localWrites: true,
      ok: true,
      files: ["Objects/fields/custitem_nsagent_hazmat_class.xml", "manifest.xml"],
    });
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

  it("refuses an ID that exists in NetSuite but not in the project, even if applied elsewhere", async () => {
    const { call } = await connect({ columns: { ...OPEN_TABLES, transaction: ["custbody_nsagent_rush"] } });
    const r = await call("ns_field_generate", { ...RUSH, replace: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("already exists in NetSuite and is not in the SDF project");
    expect(await readdir(path.join(dir, "Objects"))).toEqual([]);
  });

  it("refuses unchecked tables unless acceptUnchecked is true", async () => {
    const { partner, job, ...readable } = OPEN_TABLES;
    void partner;
    void job;
    const { call } = await connect({ columns: readable });
    const spec = { kind: "entity", name: "tier", label: "Tier", type: "TEXT", appliesTo: ["customer"] };
    const refused = await call("ns_field_generate", spec);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("could not prove custentity_nsagent_tier is unused on partner, job");
    const accepted = await call("ns_field_generate", { ...spec, acceptUnchecked: true });
    expect(accepted.json).toMatchObject({ uncheckedTables: ["partner", "job"] });
  });

  it("refuses to write through a symbolic link", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "outside-"));
    await rm(path.join(dir, "Objects"), { recursive: true });
    await symlink(outside, path.join(dir, "Objects"));
    const { call } = await connect();
    const r = await call("ns_field_generate", RUSH);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("symbolic link");
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses when the SDF project folder is missing", async () => {
    process.env.NS_AGENT_SDF_DIR = path.join(dir, "nope");
    const { call } = await connect();
    const r = await call("ns_field_generate", RUSH);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("NS_AGENT_SDF_DIR");
  });
});
