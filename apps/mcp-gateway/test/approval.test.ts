import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ApprovalDeniedError,
  ApprovalInvalidError,
  ApprovalPendingError,
  MemoryApprovalStore,
  SqliteApprovalStore,
  StoredApprovals,
  type ApprovalStore,
} from "../src";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function sqliteStore(): ApprovalStore {
  const dir = mkdtempSync(path.join(tmpdir(), "ns-approvals-"));
  dirs.push(dir);
  return new SqliteApprovalStore(path.join(dir, "approvals.sqlite"));
}

const ACCOUNT = "TSTDRV1755417";
const TARGET = { tool: "ns_search_save", accountId: ACCOUNT, payloadHash: "a".repeat(64) };

describe.each([
  ["memory", () => new MemoryApprovalStore()],
  ["sqlite", sqliteStore],
])("StoredApprovals (%s store)", (_name, makeStore) => {
  function setup(opts: { approvers?: string[] } = {}) {
    let now = Date.parse("2026-10-21T12:00:00Z");
    const approvals = new StoredApprovals({
      store: makeStore(),
      approvers: new Set(opts.approvers ?? ["doma"]),
      now: () => now,
    });
    const advance = (minutes: number) => (now += minutes * 60_000);
    const open = (ttlMinutes?: number) =>
      approvals.request({ ...TARGET, preview: "Save search 'Open AR > 60 days'", payload: { title: "x" }, requestedBy: "doma", ttlMinutes });
    return { approvals, advance, open };
  }

  it("creates a pending request that cannot be consumed before approval", async () => {
    const { approvals, open } = setup();
    const req = await open();
    expect(req).toMatchObject({ status: "pending", tool: "ns_search_save", accountId: ACCOUNT, requestedBy: "doma" });
    expect(req.approvalId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(approvals.consume(req.approvalId, TARGET)).rejects.toBeInstanceOf(ApprovalPendingError);
  });

  it("only accepts decisions from a named approver on the allowlist", async () => {
    const { approvals, open } = setup({ approvers: ["doma"] });
    const req = await open();
    await expect(approvals.decide(req.approvalId, { approver: "mallory", approve: true })).rejects.toThrow(/not an approver/);
    await expect(approvals.decide(req.approvalId, { approver: "", approve: true })).rejects.toBeInstanceOf(ApprovalInvalidError);
  });

  it("lets the requester approve their own change (ADR 0004 decision 2)", async () => {
    const { approvals, open } = setup();
    const req = await open();
    const decided = await approvals.decide(req.approvalId, { approver: "doma", approve: true });
    expect(decided).toMatchObject({ status: "approved", decidedBy: "doma" });
    await expect(approvals.consume(req.approvalId, TARGET)).resolves.toEqual({ approvalId: req.approvalId, approvedBy: "doma" });
  });

  it("is single use", async () => {
    const { approvals, open } = setup();
    const req = await open();
    await approvals.decide(req.approvalId, { approver: "doma", approve: true });
    await approvals.consume(req.approvalId, TARGET);
    await expect(approvals.consume(req.approvalId, TARGET)).rejects.toThrow(/already used/);
  });

  it("lets exactly one of two concurrent consumers through", async () => {
    const { approvals, open } = setup();
    const req = await open();
    await approvals.decide(req.approvalId, { approver: "doma", approve: true });
    const results = await Promise.allSettled([approvals.consume(req.approvalId, TARGET), approvals.consume(req.approvalId, TARGET)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("binds the approval to the payload hash, tool and account, without burning it on a mismatch", async () => {
    const { approvals, open } = setup();
    const req = await open();
    await approvals.decide(req.approvalId, { approver: "doma", approve: true });
    await expect(approvals.consume(req.approvalId, { ...TARGET, payloadHash: "b".repeat(64) })).rejects.toThrow(/payload changed/);
    await expect(approvals.consume(req.approvalId, { ...TARGET, tool: "ns_other" })).rejects.toThrow(/payload changed/);
    await expect(approvals.consume(req.approvalId, { ...TARGET, accountId: "1234567" })).rejects.toThrow(/payload changed/);
    await expect(approvals.consume(req.approvalId, TARGET)).resolves.toMatchObject({ approvedBy: "doma" });
  });

  it("expires 15 minutes after approval by default", async () => {
    const { approvals, advance, open } = setup();
    const req = await open();
    await approvals.decide(req.approvalId, { approver: "doma", approve: true });
    advance(16);
    await expect(approvals.consume(req.approvalId, TARGET)).rejects.toThrow(/expired/);
    expect((await approvals.get(req.approvalId))?.status).toBe("expired");
  });

  it("honours a per-tool approval window", async () => {
    const { approvals, advance, open } = setup();
    const req = await open(60);
    await approvals.decide(req.approvalId, { approver: "doma", approve: true });
    advance(30);
    await expect(approvals.consume(req.approvalId, TARGET)).resolves.toMatchObject({ approvedBy: "doma" });
  });

  it("cannot be approved after the pending window closes", async () => {
    const { approvals, advance, open } = setup();
    const req = await open();
    advance(25 * 60);
    await expect(approvals.decide(req.approvalId, { approver: "doma", approve: true })).rejects.toThrow(/expired/);
  });

  it("reports a denial with its reason", async () => {
    const { approvals, open } = setup();
    const req = await open();
    await approvals.decide(req.approvalId, { approver: "doma", approve: false, reason: "wrong filter" });
    const err = await approvals.consume(req.approvalId, TARGET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalDeniedError);
    expect((err as Error).message).toMatch(/wrong filter/);
  });

  it("cannot decide twice", async () => {
    const { approvals, open } = setup();
    const req = await open();
    await approvals.decide(req.approvalId, { approver: "doma", approve: false });
    await expect(approvals.decide(req.approvalId, { approver: "doma", approve: true })).rejects.toThrow(/not pending/);
  });

  it("rejects an approval whose approver was removed from the allowlist", async () => {
    const store = makeStore();
    const approvals = new StoredApprovals({ store, approvers: new Set(["doma"]) });
    const req = await approvals.request({ ...TARGET, preview: "p", payload: {}, requestedBy: "doma" });
    await approvals.decide(req.approvalId, { approver: "doma", approve: true });
    const later = new StoredApprovals({ store, approvers: new Set(["someone-else"]) });
    await expect(later.consume(req.approvalId, TARGET)).rejects.toThrow(/no longer an approver/);
  });

  it("records the outcome after execution", async () => {
    const { approvals, open } = setup();
    const req = await open();
    await approvals.decide(req.approvalId, { approver: "doma", approve: true });
    await approvals.consume(req.approvalId, TARGET);
    await approvals.complete(req.approvalId, true);
    expect((await approvals.get(req.approvalId))?.status).toBe("executed");
  });

  it("reports an unknown approval id", async () => {
    const { approvals } = setup();
    await expect(approvals.consume("00000000-0000-4000-8000-000000000000", TARGET)).rejects.toThrow(/unknown approval/);
  });
});
