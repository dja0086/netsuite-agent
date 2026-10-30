import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { JsonlAuditSink, evaluateAlerts, pruneAuditFiles, readAuditEntries, type AuditEntry } from "../src";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function auditFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ns-audit-"));
  dirs.push(dir);
  return path.join(dir, "gateway.jsonl");
}

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  ts: "2026-10-30T12:00:00.000Z",
  event: "tool.call",
  tool: "ns_suiteql",
  writes: false,
  ok: true,
  ms: 5,
  inputHash: "a".repeat(64),
  ...over,
});

describe("audit files", () => {
  it("writes each entry to its UTC month's file and reads back only the window", async () => {
    const file = auditFile();
    const sink = new JsonlAuditSink(file);
    await sink.write(entry({ ts: "2026-09-30T23:59:59.000Z" }));
    await sink.write(entry({ ts: "2026-10-01T00:00:00.000Z" }));
    await sink.write(entry({ ts: "2026-10-30T12:00:00.000Z" }));
    expect(readdirSync(path.dirname(file)).sort()).toEqual(["gateway-2026-09.jsonl", "gateway-2026-10.jsonl"]);

    const read = await readAuditEntries(file, new Date("2026-10-01T00:00:00.000Z"));
    expect(read.map((e) => e.ts)).toEqual(["2026-10-01T00:00:00.000Z", "2026-10-30T12:00:00.000Z"]);
  });

  it("treats entries without an event as tool calls and skips a torn line", async () => {
    const file = auditFile();
    const legacy = { ts: "2026-10-21T00:52:44.531Z", tool: "ns_suiteql", writes: false, ok: true, ms: 1, inputHash: "b".repeat(64) };
    writeFileSync(path.join(path.dirname(file), "gateway-2026-10.jsonl"), JSON.stringify(legacy) + "\n" + '{"ts":"2026-10-2');
    const read = await readAuditEntries(file, new Date("2026-10-01T00:00:00.000Z"));
    expect(read).toHaveLength(1);
    expect(read[0]!.event).toBe("tool.call");
  });

  it("prunes only months that ended more than 365 days ago", async () => {
    const file = auditFile();
    const dir = path.dirname(file);
    for (const month of ["2025-09", "2025-10", "2025-11", "2026-10"]) writeFileSync(path.join(dir, `gateway-${month}.jsonl`), "");
    writeFileSync(path.join(dir, "other-2020-01.jsonl"), "");

    const deleted = await pruneAuditFiles(file, new Date("2026-11-15T00:00:00.000Z"));
    // 365 days before 2026-11-15 is 2025-11-15: September and October 2025 have ended by then, November has not.
    expect(deleted.map((p) => path.basename(p))).toEqual(["gateway-2025-09.jsonl", "gateway-2025-10.jsonl"]);
    expect(readdirSync(dir).sort()).toEqual(["gateway-2025-11.jsonl", "gateway-2026-10.jsonl", "other-2020-01.jsonl"]);
  });
});

describe("evaluateAlerts", () => {
  const calls = (n: number, over: Partial<AuditEntry> = {}) => Array.from({ length: n }, () => entry(over));

  it("stays quiet when the rejected ratio is at or under 10%", () => {
    const report = evaluateAlerts([...calls(9), ...calls(1, { ok: false, errorCode: "HTTP_429" })]);
    expect(report).toMatchObject({ calls: 10, rejected: 1, alerts: [] });
  });

  it("alerts above 10% and names the codes; bad input and pending approvals do not count", () => {
    const report = evaluateAlerts([
      ...calls(16),
      ...calls(2, { ok: false, errorCode: "HTTP_429" }),
      ...calls(1, { ok: false, errorCode: "INSUFFICIENT_PERMISSION" }),
      ...calls(5, { ok: false, errorCode: "INVALID_INPUT" }),
      ...calls(1, { ok: false, errorCode: "APPROVAL_PENDING", writes: true }),
    ]);
    expect(report.rejected).toBe(3);
    expect(report.rejectedByCode).toEqual({ HTTP_429: 2, INSUFFICIENT_PERMISSION: 1 });
    expect(report.alerts).toEqual([expect.objectContaining({ kind: "rejected_ratio" })]);
    expect(report.alerts[0]!.summary).toContain("3 of 25 calls rejected (12.0%");
  });

  it("does not alert on the ratio below the minimum number of calls", () => {
    const report = evaluateAlerts(calls(3, { ok: false, errorCode: "HTTP_500" }));
    expect(report.alerts).toEqual([]);
  });

  it("alerts on every failed approval: denied, refused, or approved but failed", () => {
    const report = evaluateAlerts([
      entry({ event: "approval.requested", writes: true, approvalId: "r1" }),
      entry({ event: "approval.decided", writes: true, ok: false, approvalId: "d1", tool: "ns_search_save" }),
      entry({ event: "approval.rejected", writes: true, ok: false, approvalId: "x1", errorCode: "APPROVAL_INVALID" }),
      entry({ event: "tool.call", writes: true, ok: false, approvalId: "w1", errorCode: "HTTP_400", tool: "ns_import_run" }),
      entry({ event: "tool.call", writes: true, ok: true, approvalId: "ok1" }),
    ]);
    expect(report.failedApprovals.map((f) => f.approvalId)).toEqual(["d1", "x1", "w1"]);
    expect(report.alerts.map((a) => a.summary.split(":")[0])).toEqual(["approval denied", "approval refused", "approved write failed"]);
  });
});
