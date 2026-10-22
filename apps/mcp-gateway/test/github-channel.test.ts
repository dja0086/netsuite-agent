import { describe, expect, it } from "vitest";
import {
  ApprovalInvalidError,
  ApprovalPendingError,
  GitHubIssueChannel,
  MemoryApprovalStore,
  StoredApprovals,
  type GitHubApi,
  type GitHubComment,
} from "../src";

function fakeGitHub() {
  const issues = new Map<number, { title: string; body: string; open: boolean; comments: GitHubComment[] }>();
  let next = 100;
  let clock = Date.parse("2026-10-21T12:00:00Z");
  const api: GitHubApi = {
    async createIssue(title, body) {
      const number = ++next;
      issues.set(number, { title, body, open: true, comments: [] });
      return { number, url: `https://github.com/o/r/issues/${number}` };
    },
    async listComments(number) {
      return issues.get(number)!.comments;
    },
    async comment(number, body) {
      issues.get(number)!.comments.push({ id: Math.random(), login: "ns-agent-bot", body, createdAt: new Date((clock += 1000)).toISOString() });
    },
    async close(number) {
      issues.get(number)!.open = false;
    },
  };
  const say = (number: number, login: string, body: string) =>
    issues.get(number)!.comments.push({ id: Math.random(), login, body, createdAt: new Date((clock += 1000)).toISOString() });
  return { api, issues, say };
}

const TARGET = { tool: "ns_search_save", accountId: "TSTDRV1755417", payloadHash: "ab12cd34ef56".padEnd(64, "0") };

function setup() {
  const gh = fakeGitHub();
  const channel = new GitHubIssueChannel({ api: gh.api, repo: "o/r" });
  const approvals = new StoredApprovals({ store: new MemoryApprovalStore(), approvers: new Set(["dja0086"]), channel });
  const open = () => approvals.request({ ...TARGET, preview: "Save search 'Open AR'", payload: { title: "x" }, requestedBy: "doma" });
  return { gh, approvals, open };
}

describe("GitHub issue approval channel (ADR 0004)", () => {
  it("opens an issue with the preview and the hash prefix, never the payload", async () => {
    const { gh, open } = setup();
    const req = await open();
    expect(req).toMatchObject({ channel: "github", channelRef: "https://github.com/o/r/issues/101" });
    const issue = gh.issues.get(101)!;
    expect(issue.title).toBe("Approve ns_search_save on TSTDRV1755417");
    expect(issue.body).toContain("Save search 'Open AR'");
    expect(issue.body).toContain("/approve ab12cd34ef56");
    expect(issue.body).toContain(req.approvalId);
    expect(issue.body).not.toContain('"title"');
  });

  it("stays pending until an allowlisted login comments /approve with the right hash prefix", async () => {
    const { gh, approvals, open } = setup();
    const req = await open();
    await expect(approvals.consume(req.approvalId, TARGET)).rejects.toBeInstanceOf(ApprovalPendingError);
    gh.say(101, "mallory", "/approve ab12cd34ef56");
    gh.say(101, "dja0086", "/approve 000000000000");
    gh.say(101, "dja0086", "looks good");
    await expect(approvals.consume(req.approvalId, TARGET)).rejects.toBeInstanceOf(ApprovalPendingError);
    gh.say(101, "dja0086", "/approve ab12cd34ef56");
    await expect(approvals.consume(req.approvalId, TARGET)).resolves.toEqual({ approvalId: req.approvalId, approvedBy: "dja0086" });
    await approvals.complete(req.approvalId, true);
    const issue = gh.issues.get(101)!;
    expect(issue.open).toBe(false);
    expect(issue.comments.at(-1)!.body).toMatch(/Executed/);
  });

  it("records a /deny with its reason and closes the issue", async () => {
    const { gh, approvals, open } = setup();
    const req = await open();
    gh.say(101, "dja0086", "/deny wrong subsidiary");
    const err = await approvals.consume(req.approvalId, TARGET).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/denied by dja0086: wrong subsidiary/);
    expect(gh.issues.get(101)!.open).toBe(false);
  });

  it("refuses CLI decisions on requests that went through GitHub", async () => {
    const { approvals, open } = setup();
    const req = await open();
    await expect(approvals.decide(req.approvalId, { approver: "dja0086", approve: true, via: "cli" })).rejects.toThrow(
      ApprovalInvalidError,
    );
  });
});

describe("approvalsFromEnv with the GitHub channel", () => {
  it("needs a repo, and is the only channel allowed in production", async () => {
    const { approvalsFromEnv } = await import("../src");
    const base = { NS_AGENT_APPROVERS: "dja0086", NS_AGENT_APPROVALS_DB: ":memory:" };
    expect(() => approvalsFromEnv({ ...base, NS_TARGET_KIND: "production" })).toThrow(/CLI approval channel is for demo and sandbox/);
    expect(() => approvalsFromEnv({ ...base, NS_TARGET_KIND: "demo", NS_AGENT_APPROVAL_CHANNEL: "github" })).toThrow(/NS_AGENT_GITHUB_REPO/);
    expect(() => approvalsFromEnv({ ...base, NS_TARGET_KIND: "demo", NS_AGENT_APPROVAL_CHANNEL: "slack" })).toThrow(/unknown approval channel/);
    const gh = approvalsFromEnv({ ...base, NS_TARGET_KIND: "production", NS_AGENT_APPROVAL_CHANNEL: "github", NS_AGENT_GITHUB_REPO: "o/r" });
    expect(gh.enabled).toBe(true);
  });
});

describe("GitHub decisions in the audit log and the agent hint", () => {
  it("audits a decision made on GitHub, and tells the agent where to approve", async () => {
    const { MemoryAuditSink, createGateway, defineTool, ALL_TOOLS } = await import("../src");
    const { z } = await import("zod");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const gh = fakeGitHub();
    const audit = new MemoryAuditSink();
    const approvals = new StoredApprovals({
      store: new MemoryApprovalStore(),
      approvers: new Set(["dja0086"]),
      channel: new GitHubIssueChannel({ api: gh.api, repo: "o/r" }),
      audit,
    });
    const tool = defineTool({
      name: "ns_test_write", title: "t", description: "t", writes: true, input: z.object({ v: z.string() }),
      async describeChange() { return "Write"; },
      async handler() { return { ok: true }; },
    });
    const { server } = createGateway({
      ns: { request: async () => ({}) as never },
      skills: [{ dir: "/s", body: "", manifest: { name: "w", description: "test skill description long enough", version: "1.0.0", owner: "@t", tools: ["ns_test_write"], writes: true, enabled: true, platform: false, deprecated: false, governance_budget: { max_calls_per_invocation: 5, max_concurrency: 1 } } }],
      tools: [...ALL_TOOLS, tool as never], audit, approvals, redactFields: new Set(), accountId: "TSTDRV1755417", requestedBy: "doma",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(ct);
    const first = JSON.parse(((await client.callTool({ name: "ns_test_write", arguments: { v: "x" } })).content as Array<{ text: string }>)[0]!.text);
    expect(first.next).toContain("https://github.com/o/r/issues/101");
    expect(first.next).not.toContain("pnpm approvals");
    const prefix = (await approvals.get(first.approvalId))!.payloadHash.slice(0, 12);
    gh.say(101, "dja0086", `/approve ${prefix}`);
    await client.callTool({ name: "ns_test_write", arguments: { v: "x", approvalId: first.approvalId } });
    expect(audit.entries.map((e) => e.event)).toEqual(["approval.requested", "approval.decided", "tool.call"]);
    expect(audit.entries[1]).toMatchObject({ ok: true, approvalId: first.approvalId, approvedBy: "dja0086", actor: "dja0086" });
  });
});
