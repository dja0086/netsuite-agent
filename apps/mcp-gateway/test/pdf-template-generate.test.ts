import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NsRequester } from "@ns-agent/ns-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DenyAllApprovals, MemoryAuditSink, createGateway, type LoadedSkill } from "../src";

const skill: LoadedSkill = {
  dir: "/skills/pdf-templates",
  body: "",
  manifest: {
    name: "pdf-templates",
    description: "test skill description that is long enough to pass validation",
    version: "0.1.0",
    owner: "@t",
    tools: ["ns_pdf_template_generate"],
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

const SOURCE = `<?xml version="1.0"?>
<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">
<pdf>
  <head><link name="NotoSans" type="font" subtype="truetype" src="\${nsfont.NotoSans_Regular}"/></head>
  <body size="Letter"><#assign total = record.total><h1>\${record.tranid}</h1><p>\${total}</p></body>
</pdf>`;

const INVOICE = { record: "invoice", purpose: "standard", title: "NS Agent - Invoice", source: SOURCE };
const ID = "custtmpl_nsagent_invoice_standard";

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

async function connect() {
  const requests: string[] = [];
  const ns: NsRequester = {
    async request() {
      requests.push("called");
      throw new Error("ns_pdf_template_generate must not call NetSuite");
    },
  };
  const audit = new MemoryAuditSink();
  const { server } = createGateway({
    ns,
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
  const call = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: "ns_pdf_template_generate", arguments: args });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    return { isError: Boolean(res.isError), text, json: res.isError ? undefined : (JSON.parse(text) as Record<string, unknown>) };
  };
  return { call, audit, requests };
}

describe("ns_pdf_template_generate", () => {
  it("writes the object, its template source and the manifest features without calling NetSuite", async () => {
    const { call, audit, requests } = await connect();
    const r = await call(INVOICE);
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      scriptId: ID,
      replaced: false,
      written: [`Objects/templates/${ID}.xml`, `Objects/templates/${ID}.template.xml`, "manifest.xml"],
      manifestFeaturesAdded: ["ACCOUNTING", "ADVANCEDPRINTING"],
      sourceSha256: createHash("sha256").update(SOURCE).digest("hex"),
      review: { resources: ["${nsfont.NotoSans_Regular}"], assignments: ["total"] },
    });
    const object = await readFile(path.join(dir, "Objects/templates", `${ID}.xml`), "utf8");
    expect(object).toContain(`<advancedpdftemplate scriptid="${ID}" standard="STDTMPLCUSTINVC">`);
    expect(object).toContain("<preferred>F</preferred>");
    expect(await readFile(path.join(dir, "Objects/templates", `${ID}.template.xml`), "utf8")).toBe(`${SOURCE}\n`);
    expect(await readFile(path.join(dir, "manifest.xml"), "utf8")).toContain('<feature required="true">ADVANCEDPRINTING</feature>');
    expect(requests).toEqual([]);
    expect(audit.entries.at(-1)).toMatchObject({ ok: true, localWrites: true, files: r.json!.written });
  });

  it("refuses to overwrite a template the project owns unless replace is true", async () => {
    const { call } = await connect();
    await call(INVOICE);
    const changed = SOURCE.replace("<h1>", "<h2>").replace("</h1>", "</h2>");
    const refused = await call({ ...INVOICE, source: changed });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain("already in the SDF project; pass replace: true");
    const replaced = await call({ ...INVOICE, source: changed, replace: true });
    expect(replaced.json).toMatchObject({ replaced: true, written: [`Objects/templates/${ID}.xml`, `Objects/templates/${ID}.template.xml`] });
    expect(await readFile(path.join(dir, "Objects/templates", `${ID}.template.xml`), "utf8")).toContain("<h2>");
  });

  it("refuses a source that fails the lint before writing anything", async () => {
    const { call } = await connect();
    const r = await call({ ...INVOICE, source: SOURCE.replace("<h1>", '<img src="https://cdn.example.com/x.png"/><h1>') });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("only NetSuite addresses may be referenced, found cdn.example.com");
    expect(await readdir(path.join(dir, "Objects"))).toEqual([]);
    expect(await readFile(path.join(dir, "manifest.xml"), "utf8")).toBe(MANIFEST);
  });

  it("refuses a templates folder that is a symbolic link", async () => {
    const elsewhere = await mkdtemp(path.join(tmpdir(), "elsewhere-"));
    await symlink(elsewhere, path.join(dir, "Objects/templates"));
    const { call } = await connect();
    const r = await call(INVOICE);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("symbolic link");
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it("refuses record types sdf-gen has no standard template for", async () => {
    const { call } = await connect();
    const r = await call({ ...INVOICE, record: "vendorbill" });
    expect(r.isError).toBe(true);
    expect(await readdir(path.join(dir, "Objects"))).toEqual([]);
  });
});
