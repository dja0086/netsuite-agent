/**
 * pnpm audit:prune                      delete monthly audit files older than the retention (365 days)
 * pnpm audit:alerts [--hours 24] [--issue]
 *   Checks the last N hours of the gateway audit log against the alert thresholds (rejected-request ratio,
 *   failed approvals). Prints the report; exits 1 when an alert fires. With --issue it also opens a GitHub issue
 *   on NS_AGENT_ALERT_REPO for the on-call owner. The issue holds counts, tool names, error codes and approval
 *   ids only, never inputs or results (the repo is public). Reads local files only, never NetSuite.
 */
import {
  AUDIT_RETENTION_DAYS,
  GhCliGitHubApi,
  auditPathFromEnv,
  evaluateAlerts,
  pruneAuditFiles,
  readAuditEntries,
} from "@ns-agent/mcp-gateway";

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(name);
const option = (name: string) => {
  const at = rest.indexOf(name);
  return at >= 0 ? rest[at + 1] : undefined;
};

async function main(): Promise<number> {
  const file = auditPathFromEnv();
  const now = new Date();
  switch (command) {
    case "prune": {
      const deleted = await pruneAuditFiles(file, now);
      console.log(deleted.length ? `Deleted ${deleted.join(", ")}` : `Nothing older than ${AUDIT_RETENTION_DAYS} days.`);
      return 0;
    }
    case "alerts": {
      const hours = Number(option("--hours") ?? 24);
      if (!Number.isFinite(hours) || hours <= 0) throw new Error("--hours must be a positive number");
      const since = new Date(now.getTime() - hours * 3_600_000);
      const report = evaluateAlerts(await readAuditEntries(file, since));
      const lines = [
        `Window: ${since.toISOString()} to ${now.toISOString()} (${hours} h)`,
        `Calls: ${report.calls}, rejected: ${report.rejected}, failed approvals: ${report.failedApprovals.length}`,
        ...report.alerts.map((a) => `- ${a.kind}: ${a.summary}`),
      ];
      console.log(lines.join("\n"));
      if (!report.alerts.length) return 0;
      if (flag("--issue")) {
        const repo = process.env.NS_AGENT_ALERT_REPO?.trim();
        if (!repo) throw new Error("Set NS_AGENT_ALERT_REPO (owner/name) to open alert issues.");
        const body = [
          "The daily audit check found the alerts below. Follow `docs/runbook.md`, \"Alerts\", then close this issue.",
          "",
          ...lines,
        ].join("\n");
        const issue = await new GhCliGitHubApi(repo).createIssue(
          `NS Agent alert ${now.toISOString().slice(0, 10)}: ${report.alerts.length} alert(s)`,
          body,
        );
        console.log(`Opened ${issue.url}`);
      }
      return 1;
    }
    default:
      console.error("Usage: pnpm audit:prune | pnpm audit:alerts [--hours 24] [--issue]");
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(2);
  },
);
