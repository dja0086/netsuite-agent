import path from "node:path";
import { DenyAllApprovals, StoredApprovals, type ApprovalService } from "./approval";
import { SqliteApprovalStore } from "./approval-store";
import { auditSinkFromEnv } from "./audit";
import { GhCliGitHubApi, GitHubIssueChannel, RestGitHubApi } from "./github-channel";

/** Named approvers from NS_AGENT_APPROVERS (comma-separated). */
export function approversFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.NS_AGENT_APPROVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

export function approvalsDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.NS_AGENT_APPROVALS_DB?.trim() || path.resolve("audit", "approvals.sqlite");
}

/**
 * Writes stay refused (DenyAllApprovals) until NS_AGENT_APPROVERS names at least one approver.
 * The only channel so far is the local CLI, which ADR 0004 limits to demo and sandbox accounts.
 */
export function approvalsFromEnv(env: NodeJS.ProcessEnv = process.env): ApprovalService {
  const writes = env.NS_AGENT_WRITES?.trim().toLowerCase();
  // NS_AGENT_WRITES=off wins over everything: no write can be requested, approved or run.
  if (writes === "off") return new DenyAllApprovals();
  // request-only (agent evals): write tools return a real approval_pending preview, but the approver list is
  // empty, so no request can ever be approved and no write can run.
  if (writes === "request-only") {
    return new StoredApprovals({ store: new SqliteApprovalStore(approvalsDbPath(env)), approvers: new Set() });
  }
  const approvers = approversFromEnv(env);
  if (approvers.size === 0) return new DenyAllApprovals();
  const kind = env.NS_TARGET_KIND?.trim().toLowerCase();
  const channel = env.NS_AGENT_APPROVAL_CHANNEL?.trim().toLowerCase() || "cli";
  if (channel === "github") {
    // Approvers are GitHub logins; the commenter's login is the approver of record. Allowed in production.
    const repo = env.NS_AGENT_GITHUB_REPO?.trim();
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("NS_AGENT_APPROVAL_CHANNEL=github needs NS_AGENT_GITHUB_REPO=<owner>/<repo>");
    const token = env.NS_AGENT_GITHUB_TOKEN?.trim();
    const api = token ? new RestGitHubApi(repo, token) : new GhCliGitHubApi(repo);
    return new StoredApprovals({
      store: new SqliteApprovalStore(approvalsDbPath(env)),
      approvers,
      channel: new GitHubIssueChannel({ api, repo }),
      audit: auditSinkFromEnv(env),
    });
  }
  if (channel !== "cli") throw new Error(`unknown approval channel "${channel}"; use cli or github`);
  if (kind !== "demo" && kind !== "sandbox") {
    throw new Error(
      `NS_AGENT_APPROVERS is set but NS_TARGET_KIND is ${kind ? `"${kind}"` : "not set"}: ` +
        "the CLI approval channel is for demo and sandbox accounts only (ADR 0004).",
    );
  }
  return new StoredApprovals({ store: new SqliteApprovalStore(approvalsDbPath(env)), approvers });
}
