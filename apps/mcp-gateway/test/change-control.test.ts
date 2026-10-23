import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NsRequester } from "@ns-agent/ns-client";
import { templateArtifact } from "@ns-agent/sdf-gen";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DenyAllApprovals, MemoryAuditSink, createGateway, type LoadedSkill } from "../src";
import { commands } from "../src/tools/change-control";

const skill: LoadedSkill = {
  dir: "/skills/change-control",
  body: "",
  manifest: {
    name: "change-control",
    description: "test skill description that is long enough to pass validation",
    version: "0.2.0",
    owner: "@t",
    tools: ["ns_change_open_pr"],
    writes: false,
    enabled: true,
    platform: true,
    deprecated: false,
    governance_budget: { max_calls_per_invocation: 1, max_concurrency: 1 },
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
const WITH_FEATURES = MANIFEST.replace(
  '<feature required="true">SERVERSIDESCRIPTING</feature>',
  '<feature required="true">ACCOUNTING</feature>\n      <feature required="true">ADVANCEDPRINTING</feature>\n      <feature required="true">SERVERSIDESCRIPTING</feature>',
);
const SOURCE = `<?xml version="1.0"?>
<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">
<pdf><body><img src="\${companyInformation.logoUrl}"/><#assign shown = record.tranid><h1>\${shown}</h1></body></pdf>`;
const ID = "custtmpl_nsagent_invoice_standard";
const ARGS = { title: "Add the standard invoice template", summary: "Finance agreed the layout on invoice 4711.", scriptIds: [ID] };

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let work: string;
let bare: string;
let login: string;
let prRequests: Array<{ title: string; head: string; base: string; body: string }>;
const realRun = commands.run;

beforeEach(async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "change-pr-")));
  bare = path.join(dir, "remote.git");
  work = path.join(dir, "work");
  sh(dir, "init", "-q", "--bare", "-b", "main", bare);
  sh(dir, "init", "-q", "-b", "main", work);
  sh(work, "config", "user.name", "Test");
  sh(work, "config", "user.email", "test@example.com");
  sh(work, "config", "commit.gpgsign", "false");
  await mkdir(path.join(work, "netsuite/src/Objects"), { recursive: true });
  await writeFile(path.join(work, "netsuite/src/manifest.xml"), MANIFEST);
  await writeFile(path.join(work, "netsuite/src/Objects/.gitkeep"), "");
  await writeFile(path.join(work, "README.md"), "repo\n");
  sh(work, "add", ".");
  sh(work, "commit", "-q", "-m", "init");
  sh(work, "remote", "add", "origin", "https://github.com/dja0086/netsuite-agent.git");
  sh(work, "push", "-q", bare, "main");
  process.env.NS_AGENT_SDF_DIR = path.join(work, "netsuite/src");
  login = "dja0086";
  prRequests = [];
  // Network side faked: fetch and push go to the local bare repo, gh answers from memory. Everything else is real git.
  commands.run = async (cmd, args, opts) => {
    if (cmd === "gh") {
      if (args[0] === "api" && args[1] === "user") return `${login}\n`;
      if (args.includes("repos/dja0086/netsuite-agent/pulls")) {
        prRequests.push(JSON.parse(opts.input!));
        return JSON.stringify({ number: 42, html_url: "https://github.com/dja0086/netsuite-agent/pull/42" });
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    }
    if (args[0] === "fetch" || args[0] === "push") return realRun(cmd, args.map((a) => (a === "origin" ? bare : a)), opts);
    return realRun(cmd, args, opts);
  };
});
afterEach(() => {
  commands.run = realRun;
  delete process.env.NS_AGENT_SDF_DIR;
});

/** What ns_pdf_template_generate leaves on disk: the object, its source and the manifest features. */
async function generateTemplate() {
  for (const f of templateArtifact({ record: "invoice", purpose: "standard", title: "NS Agent - Invoice", source: SOURCE }).files) {
    await mkdir(path.dirname(path.join(work, "netsuite/src/Objects", f.path)), { recursive: true });
    await writeFile(path.join(work, "netsuite/src/Objects", f.path), f.content);
  }
  await writeFile(path.join(work, "netsuite/src/manifest.xml"), WITH_FEATURES);
}

async function connect() {
  const ns: NsRequester = {
    async request() {
      throw new Error("ns_change_open_pr must not call NetSuite");
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
    const res = await client.callTool({ name: "ns_change_open_pr", arguments: args });
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    return { isError: Boolean(res.isError), text, json: res.isError ? undefined : (JSON.parse(text) as Record<string, unknown>) };
  };
  return { call, audit };
}

const remoteBranches = () => sh(bare, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n");

describe("ns_change_open_pr", () => {
  it("commits only the generated files onto a branch from origin/main and opens a PR with the reviewer checklist", async () => {
    await generateTemplate();
    const statusBefore = sh(work, "status", "--porcelain");
    const { call, audit } = await connect();
    const r = await call(ARGS);
    expect(r.isError, r.text).toBe(false);
    const files = [`netsuite/src/Objects/templates/${ID}.template.xml`, `netsuite/src/Objects/templates/${ID}.xml`, "netsuite/src/manifest.xml"].sort();
    expect(r.json).toMatchObject({ number: 42, url: "https://github.com/dja0086/netsuite-agent/pull/42", base: sh(bare, "rev-parse", "main") });
    expect([...(r.json!.committed as string[])].sort()).toEqual(files);
    const branch = r.json!.branch as string;
    expect(branch).toMatch(/^nsagent\/add-the-standard-invoice-template-[0-9a-f]{8}$/);

    // The pushed commit sits on main and carries exactly the generated files.
    expect(remoteBranches()).toEqual([`refs/heads/${branch}`, "refs/heads/main"].sort());
    expect(sh(bare, "rev-parse", `${branch}^`)).toBe(sh(bare, "rev-parse", "main"));
    expect(sh(bare, "diff", "--name-only", "main", branch).split("\n").sort()).toEqual(files);
    expect(sh(bare, "log", "-1", "--format=%s", branch)).toBe(ARGS.title);

    // The PR body is what the reviewer works through.
    expect(prRequests).toHaveLength(1);
    const { head, base, body, title } = prRequests[0]!;
    expect({ head, base, title }).toEqual({ head: branch, base: "main", title: ARGS.title });
    expect(body).toContain(ARGS.summary);
    expect(body).toContain("manifest.xml now requires: ACCOUNTING, ADVANCEDPRINTING.");
    expect(body).toContain("read every `src`, `href`, `url(...)` and `<link>`");
    expect(body).toContain("${companyInformation.logoUrl}");
    expect(body).toContain("Assigned variables: `shown`.");
    expect(body).toContain("deploy-sdf");

    // The local checkout is untouched: same branch, same uncommitted files.
    expect(sh(work, "branch", "--show-current")).toBe("main");
    expect(sh(work, "status", "--porcelain")).toBe(statusBefore);
    expect(audit.entries.at(-1)).toMatchObject({ ok: true, localWrites: true, files: r.json!.committed });
  });

  it("refuses an origin that is not dja0086/netsuite-agent", async () => {
    await generateTemplate();
    sh(work, "remote", "set-url", "origin", "https://github.com/dja-cowboyallstar/netsuite-agent.git");
    const { call } = await connect();
    const r = await call(ARGS);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not github.com/dja0086/netsuite-agent");
    expect(remoteBranches()).toEqual(["refs/heads/main"]);
  });

  it("refuses a push URL that points elsewhere", async () => {
    await generateTemplate();
    sh(work, "remote", "set-url", "--push", "origin", "https://github.com/someone/netsuite-agent.git");
    const { call } = await connect();
    const r = await call(ARGS);
    expect(r.text).toContain("origin push URL is https://github.com/someone/netsuite-agent.git");
  });

  it("refuses when gh's active account is not dja0086", async () => {
    await generateTemplate();
    login = "dja-cowboyallstar";
    const { call } = await connect();
    const r = await call(ARGS);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("gh's active account is dja-cowboyallstar, not dja0086");
    expect(prRequests).toEqual([]);
  });

  it("refuses unrelated changes in the working tree and pushes nothing", async () => {
    await generateTemplate();
    await writeFile(path.join(work, "README.md"), "edited\n");
    await writeFile(path.join(work, "netsuite/src/Objects/templates/custtmpl_nsagent_invoice_other.xml"), "<x/>");
    const { call } = await connect();
    const r = await call(ARGS);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("changes this PR would not carry: README.md, netsuite/src/Objects/templates/custtmpl_nsagent_invoice_other.xml");
    expect(remoteBranches()).toEqual(["refs/heads/main"]);
  });

  it("refuses an object whose files were not generated", async () => {
    const { call } = await connect();
    const r = await call({ ...ARGS, scriptIds: ["custbody_nsagent_rush"] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("netsuite/src/Objects/fields/custbody_nsagent_rush.xml is missing");
  });

  it("refuses when HEAD's manifest differs from origin/main", async () => {
    await writeFile(path.join(work, "netsuite/src/manifest.xml"), MANIFEST.replace("SERVERSIDESCRIPTING", "CUSTOMRECORDS"));
    sh(work, "commit", "-q", "-am", "local manifest change");
    await generateTemplate();
    const { call } = await connect();
    const r = await call(ARGS);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("differs from origin/main");
    expect(remoteBranches()).toEqual(["refs/heads/main"]);
  });

  it("refuses when the files already match origin/main", async () => {
    await generateTemplate();
    sh(work, "add", ".");
    sh(work, "commit", "-q", "-m", "template");
    sh(work, "push", "-q", bare, "main");
    const { call } = await connect();
    const r = await call(ARGS);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("nothing to commit");
  });

  it("refuses an SDF project outside a git checkout", async () => {
    const elsewhere = await mkdtemp(path.join(tmpdir(), "sdf-"));
    await writeFile(path.join(elsewhere, "manifest.xml"), MANIFEST);
    process.env.NS_AGENT_SDF_DIR = elsewhere;
    const { call } = await connect();
    const r = await call(ARGS);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("is not netsuite/src of a git checkout of dja0086/netsuite-agent");
  });

  it("rejects a multi-line title and script IDs the generate tools do not write", async () => {
    const { call } = await connect();
    const title = await call({ ...ARGS, title: "Add the template\n\nCo-authored-by: someone" });
    expect(title.isError).toBe(true);
    expect(title.text).toContain("one line");
    const foreign = await call({ ...ARGS, scriptIds: ["customsearch_nsagent_ar_over_60"] });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain("nsagent fields or templates");
  });
});
