import { spawn } from "node:child_process";
import type { ApprovalChannel, ChangeRequest } from "./approval";

export interface GitHubComment {
  id: number;
  login: string;
  body: string;
  createdAt: string;
}

/** The few GitHub calls the channel needs. */
export interface GitHubApi {
  createIssue(title: string, body: string): Promise<{ number: number; url: string }>;
  listComments(issue: number): Promise<GitHubComment[]>;
  comment(issue: number, body: string): Promise<void>;
  close(issue: number): Promise<void>;
}

const HASH_PREFIX = 12;
const issueNumber = (request: ChangeRequest) => Number(request.channelRef?.match(/\/issues\/(\d+)$/)?.[1]);

/**
 * Approvals on GitHub issues (ADR 0004, decision 1). Each change request becomes an issue holding the preview and
 * the payload-hash prefix. An allowlisted GitHub login comments `/approve <prefix>` or `/deny <reason>`; that login
 * is the approver of record. The payload itself is never posted.
 */
export class GitHubIssueChannel implements ApprovalChannel {
  readonly name = "github" as const;

  constructor(private readonly options: { api: GitHubApi; repo: string }) {}

  async notify(request: ChangeRequest): Promise<{ channelRef: string }> {
    const prefix = request.payloadHash.slice(0, HASH_PREFIX);
    const body = [
      `**${request.tool}** on **${request.accountId}**, requested by ${request.requestedBy}.`,
      "",
      "> " + request.preview.replace(/\n/g, "\n> "),
      "",
      `- Approval id: \`${request.approvalId}\``,
      `- Payload hash: \`${request.payloadHash}\``,
      `- Waiting for a decision until ${request.expiresAt}; once approved it is valid for ${request.ttlMinutes} minutes, for one call with exactly this payload.`,
      "",
      `To approve, comment \`/approve ${prefix}\`. To deny, comment \`/deny <reason>\`. Only listed approvers count.`,
    ].join("\n");
    const issue = await this.options.api.createIssue(`Approve ${request.tool} on ${request.accountId}`, body);
    return { channelRef: issue.url };
  }

  async poll(request: ChangeRequest, approvers: ReadonlySet<string>) {
    const number = issueNumber(request);
    if (!Number.isFinite(number)) return undefined;
    const prefix = request.payloadHash.slice(0, HASH_PREFIX);
    for (const c of await this.options.api.listComments(number)) {
      if (!approvers.has(c.login)) continue;
      const text = c.body.trim();
      const approve = /^\/approve\s+([0-9a-f]{12})\b/i.exec(text);
      if (approve && approve[1]!.toLowerCase() === prefix) return { approve: true, approver: c.login };
      const deny = /^\/deny\b\s*([\s\S]*)$/i.exec(text);
      if (deny) return { approve: false, approver: c.login, reason: deny[1]!.trim().slice(0, 300) || undefined };
    }
    return undefined;
  }

  async report(request: ChangeRequest, text: string, close: boolean): Promise<void> {
    const number = issueNumber(request);
    if (!Number.isFinite(number)) return;
    await this.options.api.comment(number, text);
    if (close) await this.options.api.close(number);
  }
}

/** GitHub REST with a token (a fine-grained token with Issues: read and write on the one repo). */
export class RestGitHubApi implements GitHubApi {
  constructor(private readonly repo: string, private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`https://api.github.com/repos/${this.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path} failed with HTTP ${res.status}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  async createIssue(title: string, body: string) {
    const issue = await this.call<{ number: number; html_url: string }>("POST", "/issues", { title, body });
    return { number: issue.number, url: issue.html_url };
  }

  async listComments(issue: number): Promise<GitHubComment[]> {
    const rows = await this.call<Array<{ id: number; user: { login: string }; body: string; created_at: string }>>(
      "GET",
      `/issues/${issue}/comments?per_page=100`,
    );
    return rows.map((r) => ({ id: r.id, login: r.user.login, body: r.body ?? "", createdAt: r.created_at }));
  }

  async comment(issue: number, body: string) {
    await this.call("POST", `/issues/${issue}/comments`, { body });
  }

  async close(issue: number) {
    await this.call("PATCH", `/issues/${issue}`, { state: "closed" });
  }
}

/** The same calls through the GitHub CLI (`gh`), for local use with the developer's own login. */
export class GhCliGitHubApi implements GitHubApi {
  constructor(private readonly repo: string) {}

  private gh(args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("gh", ["api", ...args], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`gh api failed: ${err.trim().slice(0, 200)}`))));
      child.stdin.end(input ?? "");
    });
  }

  async createIssue(title: string, body: string) {
    const out = await this.gh(["-X", "POST", `repos/${this.repo}/issues`, "--input", "-"], JSON.stringify({ title, body }));
    const issue = JSON.parse(out) as { number: number; html_url: string };
    return { number: issue.number, url: issue.html_url };
  }

  async listComments(issue: number): Promise<GitHubComment[]> {
    const rows = JSON.parse(await this.gh([`repos/${this.repo}/issues/${issue}/comments?per_page=100`])) as Array<{
      id: number;
      user: { login: string };
      body: string;
      created_at: string;
    }>;
    return rows.map((r) => ({ id: r.id, login: r.user.login, body: r.body ?? "", createdAt: r.created_at }));
  }

  async comment(issue: number, body: string) {
    await this.gh(["-X", "POST", `repos/${this.repo}/issues/${issue}/comments`, "--input", "-"], JSON.stringify({ body }));
  }

  async close(issue: number) {
    await this.gh(["-X", "PATCH", `repos/${this.repo}/issues/${issue}`, "--input", "-"], JSON.stringify({ state: "closed" }));
  }
}
