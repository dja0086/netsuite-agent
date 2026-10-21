import path from "node:path";
import { DenyAllApprovals, StoredApprovals, type ApprovalService } from "./approval";
import { SqliteApprovalStore } from "./approval-store";

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
  if (kind !== "demo" && kind !== "sandbox") {
    throw new Error(
      `NS_AGENT_APPROVERS is set but NS_TARGET_KIND is ${kind ? `"${kind}"` : "not set"}: ` +
        "the CLI approval channel is for demo and sandbox accounts only (ADR 0004).",
    );
  }
  return new StoredApprovals({ store: new SqliteApprovalStore(approvalsDbPath(env)), approvers });
}
