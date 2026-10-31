import { describe, expect, it } from "vitest";
import { pendingApprovals, runItems, stopNote } from "../src/runs";

const text = (t: string) => [{ type: "text", text: t }];
const ev = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, processed_at: `2026-10-31T00:00:${id.slice(-2)}Z`, ...extra });

// Shaped like use case 3: a read runs, a write pauses, the owner allows it, the run finishes.
const writeRun = [
  ev("sevt_01", "user.message", { content: text("Change the email for client nsagent-phase0-test-001.") }),
  ev("sevt_02", "session.status_running"),
  ev("sevt_03", "agent.mcp_tool_use", { name: "searchCustomer", evaluated_permission: "allow", input: { query: "nsagent-phase0-test-001" } }),
  ev("sevt_04", "agent.mcp_tool_result", { mcp_tool_use_id: "sevt_03", content: text('[{"id":2928}]') }),
  ev("sevt_05", "agent.mcp_tool_use", { name: "updateCustomer", evaluated_permission: "ask", input: { customerId: "2928", email: "phase1-test@example.com" } }),
  ev("sevt_06", "session.status_idle", { stop_reason: { type: "requires_action", event_ids: ["sevt_05"] } }),
];
const afterAllow = [
  ...writeRun,
  ev("sevt_07", "user.tool_confirmation", { tool_use_id: "sevt_05", result: "allow" }),
  ev("sevt_08", "session.status_running"),
  ev("sevt_09", "agent.mcp_tool_result", { mcp_tool_use_id: "sevt_05", content: text('{"success":true}') }),
  ev("sevt_10", "agent.message", { content: text("Email changed.") }),
  ev("sevt_11", "session.status_idle", { stop_reason: { type: "end_turn" } }),
];

describe("pendingApprovals", () => {
  it("lists the paused tool call", () => {
    expect(pendingApprovals(writeRun)).toEqual(["sevt_05"]);
  });

  it("drops a call once it is answered, even before the session moves on", () => {
    expect(pendingApprovals([...writeRun, ev("sevt_07", "user.tool_confirmation", { tool_use_id: "sevt_05", result: "deny" })])).toEqual([]);
  });

  it("is empty once the run continues or finishes", () => {
    expect(pendingApprovals(afterAllow)).toEqual([]);
    expect(pendingApprovals([...writeRun, ev("sevt_07", "session.status_running")])).toEqual([]);
  });

  it("only trusts the latest idle event", () => {
    const two = [
      ...afterAllow,
      ev("sevt_12", "agent.mcp_tool_use", { name: "createCustomer", evaluated_permission: "ask", input: {} }),
      ev("sevt_13", "session.status_idle", { stop_reason: { type: "requires_action", event_ids: ["sevt_12"] } }),
    ];
    expect(pendingApprovals(two)).toEqual(["sevt_12"]);
  });
});

describe("runItems", () => {
  it("pairs each tool call with its result and keeps the decision", () => {
    const items = runItems(afterAllow);
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "tool", "decision", "agent"]);
    expect(items[2]).toMatchObject({ name: "updateCustomer", source: "netsuite", permission: "ask", result: '{"success":true}', isError: false });
    expect(items[3]).toMatchObject({ kind: "decision", toolUseId: "sevt_05", result: "allow" });
    expect(items[4]).toMatchObject({ kind: "agent", text: "Email changed." });
  });

  it("marks sandbox tools and surfaces session errors", () => {
    const items = runItems([
      ev("sevt_01", "agent.tool_use", { name: "bash", evaluated_permission: "allow", input: { command: "ls" } }),
      ev("sevt_02", "agent.tool_result", { tool_use_id: "sevt_01", content: text("out.xlsx"), is_error: false }),
      ev("sevt_03", "session.error", { error: { type: "mcp_authentication_failed_error", message: "token expired" } }),
    ]);
    expect(items[0]).toMatchObject({ kind: "tool", source: "sandbox", result: "out.xlsx" });
    expect(items[1]).toMatchObject({ kind: "error", text: "mcp_authentication_failed_error: token expired" });
  });
});

describe("stopNote", () => {
  it("explains the last stop", () => {
    expect(stopNote(writeRun)).toBe("Waiting for your approval.");
    expect(stopNote(afterAllow)).toBe("Finished.");
    expect(stopNote([ev("sevt_01", "session.status_idle", { stop_reason: { type: "budget_reached" } })])).toBe("Stopped at its spend cap.");
  });
});
