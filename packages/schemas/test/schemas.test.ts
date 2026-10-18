import { describe, expect, it } from "vitest";
import { SkillManifest, TaskEvals, TriggerEvals } from "../src";

const base = {
  name: "data-explorer",
  description: "Look up and query NetSuite data read-only. Use for questions about records and fields.",
  version: "1.0.0",
  owner: "@team",
  tools: ["ns_suiteql"],
  writes: false,
  governance_budget: { max_calls_per_invocation: 50, max_concurrency: 2 },
};

describe("SkillManifest", () => {
  it("accepts a valid manifest and applies defaults", () => {
    expect(SkillManifest.parse(base)).toMatchObject({ enabled: true, platform: false, deprecated: false });
  });

  it("rejects unknown keys so typos do not silently pass", () => {
    expect(() => SkillManifest.parse({ ...base, toolz: [] })).toThrow();
  });

  it("requires a replacement when deprecated", () => {
    expect(() => SkillManifest.parse({ ...base, deprecated: true })).toThrow(/replacement/);
  });

  it("requires tools for user-facing skills but not platform skills", () => {
    expect(() => SkillManifest.parse({ ...base, tools: [] })).toThrow(/at least one tool/);
    expect(() => SkillManifest.parse({ ...base, tools: [], platform: true })).not.toThrow();
    expect(() => SkillManifest.parse({ ...base, tools: [], enabled: false })).not.toThrow();
  });

  it("rejects tool names without the ns_ prefix", () => {
    expect(() => SkillManifest.parse({ ...base, tools: ["runQuery"] })).toThrow();
  });
});

describe("eval files", () => {
  it("requires enough trigger prompts", () => {
    expect(() => TriggerEvals.parse({ should_route: ["only one prompt"], should_not_route: [] })).toThrow();
  });

  it("parses tool and agent cases", () => {
    const parsed = TaskEvals.parse({
      cases: [
        { kind: "tool", id: "a", tool: "ns_suiteql", input: { q: "SELECT 1 FROM DUAL" }, expect: { min_rows: 1 } },
        { kind: "tool", id: "b", tool: "ns_suiteql", input: { q: "DELETE x" }, expect: { ok: false } },
        { kind: "agent", id: "c", prompt: "How many customers?", expect_tools: ["ns_suiteql"], rubric: "Gives a count" },
      ],
    });
    expect(parsed.cases).toHaveLength(3);
  });
});
