import { describe, expect, it } from "vitest";
import type { BuiltAgent } from "../src/create";
import { alertIssue } from "../src/pending";
import { RUN_BUDGET_CENTS } from "../src/run";
import { buildDeployment, checkSchedule } from "../src/schedules";

const agent: BuiltAgent = {
  agentId: "agent_01Weekly",
  version: 3,
  name: "Weekly 60+ days overdue clients",
  createdAt: "2026-10-31T00:00:00Z",
  spec: {
    name: "Weekly 60+ days overdue clients",
    description: "",
    instructions: "List clients with invoices more than 60 days overdue.",
    tier: "read",
    readTools: ["ns_runCustomSuiteQL"],
    writeTools: [],
    outputFiles: ["xlsx"],
    kickoff: "Produce this week's list.",
    openQuestions: [],
  },
};
const shared = { environmentId: "env_01Shared", vaultId: "vlt_01NetSuite" };
const weekly = { cron: "0 8 * * 1", timezone: "America/Los_Angeles", message: "Produce this week's list." };

describe("checkSchedule", () => {
  it("accepts five-field cron, a real time zone and a message", () => {
    expect(checkSchedule(weekly)).toEqual([]);
    expect(checkSchedule({ ...weekly, cron: "*/15 9-17 * * 1-5" })).toEqual([]);
  });

  it("rejects bad cron, unknown time zones and empty messages", () => {
    const problems = checkSchedule({ cron: "every monday", timezone: "Mars/Olympus", message: " " });
    expect(problems).toHaveLength(3);
    expect(checkSchedule({ ...weekly, cron: "0 8 * *" })[0]).toMatch(/five fields/);
  });
});

describe("buildDeployment", () => {
  it("pins the agent version and attaches the shared environment, NetSuite vault and run cap", () => {
    const d = buildDeployment(agent, { ...weekly, cron: " 0  8 * * 1 " }, shared);
    expect(d.agent).toEqual({ type: "agent", id: "agent_01Weekly", version: 3 });
    expect(d.environment_id).toBe("env_01Shared");
    expect(d.vault_ids).toEqual(["vlt_01NetSuite"]);
    expect(d.budget).toEqual({ type: "limit", max_list_cost: { amount: RUN_BUDGET_CENTS, currency: "USD" } });
    expect(d.schedule).toEqual({ type: "cron", expression: "0 8 * * 1", timezone: "America/Los_Angeles" });
    expect(d.initial_events).toEqual([{ type: "user.message", content: [{ type: "text", text: "Produce this week's list." }] }]);
  });

  it("refuses an invalid schedule", () => {
    expect(() => buildDeployment(agent, { ...weekly, timezone: "Nowhere" }, shared)).toThrow(/time zone/);
  });
});

describe("alertIssue", () => {
  it("names the agent and run only, nothing from the request", () => {
    // alertIssue is never given the tool call, so nothing from it can reach the public issue.
    const issue = alertIssue({ agentName: "Client contact updater", sessionId: "sesn_01Abc" }, 2);
    expect(issue.title).toBe("NetSuite agent waiting for approval: Client contact updater");
    expect(issue.body).toContain("sesn_01Abc");
    expect(issue.body).toContain("2 tool calls");
    expect(`${issue.title}\n${issue.body}`).not.toMatch(/customerId|updateCustomer|@|[0-9]{4}/);
  });
});
