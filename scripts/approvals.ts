/**
 * pnpm approvals <list|show|approve|deny> [approvalId] [--reason "..."]
 * The CLI approval channel (ADR 0004): a named approver reviews change requests the gateway recorded and
 * approves or denies them. Demo and sandbox accounts only. The approver is NS_AGENT_APPROVER, else the OS user,
 * and must be listed in NS_AGENT_APPROVERS. Talks only to the local approvals store, never to NetSuite.
 */
import { userInfo } from "node:os";
import {
  SqliteApprovalStore,
  StoredApprovals,
  approvalsDbPath,
  approversFromEnv,
  auditSinkFromEnv,
  type ChangeRequest,
} from "@ns-agent/mcp-gateway";
import { requireLiveTarget } from "./lib/target";

requireLiveTarget("approvals");
const [command = "list", id, ...rest] = process.argv.slice(2);
const reasonAt = rest.indexOf("--reason");
const reason = reasonAt >= 0 ? rest[reasonAt + 1] : undefined;

const approvers = approversFromEnv();
const approvals = new StoredApprovals({ store: new SqliteApprovalStore(approvalsDbPath()), approvers });
const approver = process.env.NS_AGENT_APPROVER?.trim() || userInfo().username;

const line = (r: ChangeRequest) =>
  `${r.approvalId}  ${r.status.padEnd(9)}  ${r.tool.padEnd(20)}  ${r.accountId}  by ${r.requestedBy}  expires ${r.expiresAt}`;

function show(r: ChangeRequest): void {
  console.log(line(r));
  console.log(`\n  ${r.preview}\n`);
  console.log(`  payload hash  ${r.payloadHash}`);
  console.log(`  payload       ${JSON.stringify(r.payload, null, 2).replace(/\n/g, "\n                ")}`);
  if (r.decidedBy) console.log(`  decided       ${r.status} by ${r.decidedBy} at ${r.decidedAt}${r.reason ? ` (${r.reason})` : ""}`);
}

async function main(): Promise<number> {
  switch (command) {
    case "list": {
      const all = await approvals.list(id === "--all" ? undefined : "pending");
      if (!all.length) console.log(id === "--all" ? "No change requests." : "No pending change requests.");
      for (const r of all) console.log(line(r));
      return 0;
    }
    case "show":
    case "approve":
    case "deny": {
      if (!id) {
        console.error(`usage: pnpm approvals ${command} <approvalId>${command === "deny" ? ' [--reason "..."]' : ""}`);
        return 2;
      }
      const r = await approvals.get(id);
      if (!r) {
        console.error(`Unknown approval ${id}.`);
        return 1;
      }
      if (command === "show") {
        show(r);
        return 0;
      }
      show(r);
      const decided = await approvals.decide(id, { approver, approve: command === "approve", reason });
      await auditSinkFromEnv().write({
        ts: new Date().toISOString(),
        event: "approval.decided",
        tool: decided.tool,
        writes: true,
        ok: decided.status === "approved",
        ms: 0,
        inputHash: decided.payloadHash,
        approvalId: decided.approvalId,
        approvedBy: decided.status === "approved" ? approver : undefined,
        actor: approver,
      });
      console.log(
        decided.status === "approved"
          ? `\nApproved by ${approver}. Valid until ${decided.expiresAt}, for one call with exactly this payload.`
          : `\nDenied by ${approver}.`,
      );
      return 0;
    }
    default:
      console.error("usage: pnpm approvals <list [--all] | show <id> | approve <id> | deny <id> [--reason \"...\"]>");
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  },
);
