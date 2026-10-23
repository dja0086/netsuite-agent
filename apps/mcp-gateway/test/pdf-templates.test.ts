import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NsHttpError, type NsRequest, type NsRequester } from "@ns-agent/ns-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DenyAllApprovals, MemoryAuditSink, createGateway, type LoadedSkill } from "../src";
import { pdfPageCount } from "../src/tools/pdf-templates";

const skill: LoadedSkill = {
  dir: "/skills/pdf-templates",
  body: "",
  manifest: {
    name: "pdf-templates",
    description: "test skill description that is long enough to pass validation",
    version: "0.1.0",
    owner: "@t",
    tools: ["ns_pdf_preview"],
    writes: false,
    enabled: true,
    platform: false,
    deprecated: false,
    governance_budget: { max_calls_per_invocation: 10, max_concurrency: 1 },
  },
};

/** A minimal PDF the way BFO writes its page tree: uncompressed, the root /Pages node holding the total. */
const fakePdf = (pages: number) =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count ${pages}>>\nendobj\n` +
      `3 0 obj\n<</Type /Page /Parent 2 0 R>>\nendobj\n%%EOF\n`,
    "latin1",
  );

const TEMPLATE = '<?xml version="1.0"?>\n<pdf><body><p>${record.tranid}</p></body></pdf>';
const PREVIEW = { recordType: "invoice", recordId: 148, templateXml: TEMPLATE };

/** Fake RESTlet: `answer` returns the response body or throws the error NetSuite would send. */
function fakeNs(answer: (body: Record<string, unknown>) => unknown = () => ({ fileName: "invoice_148.pdf", base64: fakePdf(2).toString("base64"), remainingUsage: 4980 })) {
  const requests: NsRequest[] = [];
  const ns: NsRequester = {
    async request<T>(req: NsRequest): Promise<T> {
      requests.push(req);
      return answer(req.body as Record<string, unknown>) as T;
    },
  };
  return { ns, requests };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ns-pdf-"));
  process.env.NS_AGENT_EXPORT_DIR = path.join(dir, "exports");
});
afterEach(async () => {
  delete process.env.NS_AGENT_EXPORT_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function connect(answer?: Parameters<typeof fakeNs>[0]) {
  const fake = fakeNs(answer);
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
  const call = async (args: Record<string, unknown>) => {
    const res = await client.callTool({ name: "ns_pdf_preview", arguments: args });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    return { isError: Boolean(res.isError), text, json: res.isError ? undefined : (JSON.parse(text) as Record<string, unknown>) };
  };
  return { client, call, audit, requests: fake.requests };
}

const failWith = (status: number, code: string, message: string) => () => {
  throw new NsHttpError(status, code, message);
};

describe("ns_pdf_preview", () => {
  it("is served read-only", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "ns_pdf_preview")!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it("renders through the preview RESTlet and writes the PDF to the export folder", async () => {
    const { call, requests } = await connect();
    const res = await call(PREVIEW);
    expect(res.isError).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      base: "restlet",
      query: { script: "customscript_ns_agent_pdf_rl", deploy: "customdeploy_ns_agent_pdf_rl" },
      body: { action: "preview", recordType: "invoice", recordId: 148, templateXml: TEMPLATE },
    });
    const file = res.json!.file as string;
    expect(path.dirname(file)).toBe(path.join(dir, "exports"));
    expect(path.basename(file)).toMatch(/^pdf-preview-invoice-148-\d{8}T\d{9}Z\.pdf$/);
    expect(await readFile(file)).toEqual(fakePdf(2));
    expect(res.json).toMatchObject({ bytes: fakePdf(2).length, pages: 2, recordType: "invoice", recordId: 148, remainingUsage: 4980 });
    expect(res.json!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never returns or audits the PDF contents", async () => {
    const { call, audit } = await connect();
    const res = await call(PREVIEW);
    const base64 = fakePdf(2).toString("base64");
    expect(res.text).not.toContain(base64);
    expect(res.text).not.toContain("%PDF");
    expect(JSON.stringify(audit.entries)).not.toContain(base64);
    expect(audit.entries).toEqual([expect.objectContaining({ tool: "ns_pdf_preview", event: "tool.call", ok: true, writes: false })]);
  });

  it("names the file from the validated input, never from the RESTlet's fileName", async () => {
    const { call } = await connect(() => ({ fileName: "../../escape.pdf", base64: fakePdf(1).toString("base64") }));
    const res = await call(PREVIEW);
    expect(await readdir(path.join(dir, "exports"))).toEqual([path.basename(res.json!.file as string)]);
    expect(res.json).toMatchObject({ pages: 1, remainingUsage: null });
  });

  it.each([
    ["a record type outside the allow-list", { recordType: "customer" }, "recordType"],
    ["a non-integer id", { recordId: 1.5 }, "recordId"],
    ["id 0", { recordId: 0 }, "recordId"],
    ["an empty template", { templateXml: "" }, "templateXml"],
    ["a template over 100,000 characters", { templateXml: `<pdf>${"x".repeat(100_000)}</pdf>` }, "templateXml"],
    ["text without a <pdf> root", { templateXml: "Invoice ${record.tranid}" }, "<pdf>"],
    ["a <pdfx> root", { templateXml: "<pdfx><body/></pdfx>" }, "<pdf>"],
  ])("refuses %s without calling NetSuite", async (_, change, expected) => {
    const { call, requests } = await connect();
    const res = await call({ ...PREVIEW, ...change });
    expect(res.isError).toBe(true);
    expect(res.text).toContain(expected);
    expect(requests).toHaveLength(0);
  });

  it("accepts a <pdfset> root", async () => {
    const { call } = await connect();
    expect((await call({ ...PREVIEW, templateXml: "<pdfset><pdf><body/></pdf></pdfset>" })).isError).toBe(false);
  });

  it.each([
    ["NS_AGENT_BAD_INPUT", 400, "the rendered template loads resources from outside NetSuite: src: address outside NetSuite: example.com", "NetSuite refused the preview: the rendered template loads resources from outside NetSuite"],
    ["NS_AGENT_USAGE_LOW", 400, "Only 40 usage units left; narrow the request.", "ran low on script usage units"],
    ["NS_AGENT_UNKNOWN_ACTION", 400, "Unknown action: preview", "deploy the current netsuite/ project"],
    ["RCRD_DSNT_EXIST", 400, "That record does not exist.", "invoice 148 does not exist, or the integration role cannot see it"],
    ["INVALID_TRANS_TYP", 400, "Transaction type specified is incorrect.", "148 is the internal id of a different transaction type, not invoice"],
    ["SSS_INVALID_SCRIPTLET_ID", 400, "That Suitelet is invalid, disabled, or no longer exists.", "is not deployed on this account"],
    ["USER_ERROR", 400, 'Error Parsing XML: The element type "p" must be terminated.', 'The template did not render: Error Parsing XML: The element type "p"'],
    ["UNEXPECTED_ERROR", 400, "An unexpected SuiteScript error has occurred", "how it reports most FreeMarker errors"],
  ])("explains %s", async (code, status, message, expected) => {
    const { call } = await connect(failWith(status, code, message));
    const res = await call(PREVIEW);
    expect(res.isError).toBe(true);
    expect(res.text).toContain(expected);
  });

  it("passes other NetSuite errors through with their code", async () => {
    const { call } = await connect(failWith(403, "INVALID_LOGIN_ATTEMPT", "Invalid login attempt."));
    const res = await call(PREVIEW);
    expect(res.text).toBe("NetSuite rejected the request (INVALID_LOGIN_ATTEMPT): Invalid login attempt.");
  });

  it("fails without writing a file when the RESTlet returns something other than a PDF", async () => {
    const { call, audit } = await connect(() => ({ fileName: "invoice_148.pdf", base64: Buffer.from("<html>").toString("base64") }));
    const res = await call(PREVIEW);
    expect(res.isError).toBe(true);
    expect(audit.entries[0]).toMatchObject({ ok: false, errorCode: "INTERNAL_ERROR" });
    await expect(readdir(path.join(dir, "exports"))).rejects.toThrow();
  });
});

describe("pdfPageCount", () => {
  it("reads the page tree's total", () => expect(pdfPageCount(fakePdf(7))).toBe(7));

  it("takes the root's count when page trees nest", () => {
    const pdf = Buffer.from("%PDF-1.4\n<</Type /Pages /Count 2>>\n<</Type /Pages /Kids [] /Count 5 /Parent 1 0 R>>\n<</Count 9>>", "latin1");
    expect(pdfPageCount(pdf)).toBe(5);
  });

  it("counts page leaves when no page tree count is readable", () => {
    expect(pdfPageCount(Buffer.from("%PDF-1.4\n<</Type /Page>>\n<</Type/Page /Parent 2 0 R>>", "latin1"))).toBe(2);
  });

  it("is undefined when the page tree is not readable", () => expect(pdfPageCount(Buffer.from("%PDF-1.5\nstream...", "latin1"))).toBeUndefined());
});
