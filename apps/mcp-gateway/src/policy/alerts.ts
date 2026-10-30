import type { AuditEntry } from "./audit";

/** Failures that are the caller's input or an approval still in progress, not a rejected request. */
const NOT_REJECTIONS = new Set(["INVALID_INPUT", "APPROVAL_PENDING"]);

export interface AlertThresholds {
  /** Alert when rejected calls / all calls in the window exceeds this. */
  maxRejectedRatio: number;
  /** Below this many calls the ratio is noise; no ratio alert. */
  minCalls: number;
}

/** Owner decision 2026-10-30: more than 10% rejected over at least 10 calls; any failed approval. */
export const DEFAULT_THRESHOLDS: AlertThresholds = { maxRejectedRatio: 0.1, minCalls: 10 };

export interface Alert {
  kind: "rejected_ratio" | "failed_approval";
  summary: string;
}

export interface AlertReport {
  calls: number;
  rejected: number;
  /** Rejected calls by error code, e.g. { HTTP_429: 3 }. */
  rejectedByCode: Record<string, number>;
  failedApprovals: { event: string; tool: string; approvalId?: string; errorCode?: string; ts: string }[];
  alerts: Alert[];
}

/**
 * Evaluates one window of audit entries. A rejected request is a tool call that failed for any reason other
 * than bad input or a pending approval: NetSuite errors (throttling, permissions), refused writes, internal errors.
 * A failed approval is a denied decision, a refused approval id, or an approved write that then failed.
 * The report holds counts, tool names, codes and approval ids only, never inputs or results.
 */
export function evaluateAlerts(entries: AuditEntry[], thresholds: AlertThresholds = DEFAULT_THRESHOLDS): AlertReport {
  const calls = entries.filter((e) => e.event === "tool.call");
  const rejectedCalls = calls.filter((e) => !e.ok && !NOT_REJECTIONS.has(e.errorCode ?? ""));
  const rejectedByCode: Record<string, number> = {};
  for (const e of rejectedCalls) rejectedByCode[e.errorCode ?? "UNKNOWN"] = (rejectedByCode[e.errorCode ?? "UNKNOWN"] ?? 0) + 1;

  const failedApprovals = entries
    .filter(
      (e) =>
        e.event === "approval.rejected" ||
        (e.event === "approval.decided" && !e.ok) ||
        (e.event === "tool.call" && e.writes && e.approvalId !== undefined && !e.ok),
    )
    .map((e) => ({ event: e.event, tool: e.tool, approvalId: e.approvalId, errorCode: e.errorCode, ts: e.ts }));

  const alerts: Alert[] = [];
  const ratio = calls.length ? rejectedCalls.length / calls.length : 0;
  if (calls.length >= thresholds.minCalls && ratio > thresholds.maxRejectedRatio) {
    const codes = Object.entries(rejectedByCode).map(([code, n]) => `${code} ${n}`).join(", ");
    alerts.push({
      kind: "rejected_ratio",
      summary: `${rejectedCalls.length} of ${calls.length} calls rejected (${(ratio * 100).toFixed(1)}%, limit ${thresholds.maxRejectedRatio * 100}%): ${codes}`,
    });
  }
  for (const f of failedApprovals) {
    const what =
      f.event === "approval.decided" ? "approval denied" : f.event === "approval.rejected" ? "approval refused" : "approved write failed";
    alerts.push({ kind: "failed_approval", summary: `${what}: ${f.tool}${f.approvalId ? ` (${f.approvalId})` : ""}${f.errorCode ? `, ${f.errorCode}` : ""} at ${f.ts}` });
  }
  return { calls: calls.length, rejected: rejectedCalls.length, rejectedByCode, failedApprovals, alerts };
}
