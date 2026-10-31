/**
 * pnpm --filter @ns-agent/agent-builder pending-check
 * Finds builder runs (scheduled ones included) paused on an approval and opens one GitHub issue per run on
 * BUILDER_ALERT_REPO (default dja0086/netsuite-agent). Run every 15 minutes by launchd (docs/agent-builder.md).
 */
import { alertWaiting } from "./pending";

const repo = process.env.BUILDER_ALERT_REPO?.trim() || "dja0086/netsuite-agent";
alertWaiting(repo).then(
  ({ waiting, opened }) => {
    console.log(`${new Date().toISOString()} waiting=${waiting} opened=${opened.length}${opened.length ? ` ${opened.join(" ")}` : ""}`);
  },
  (error) => {
    console.error(`${new Date().toISOString()} pending check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
