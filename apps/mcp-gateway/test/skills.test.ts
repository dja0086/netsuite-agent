import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_TOOLS, declaredTools, loadSkills, parseSkillMd, selectSkills, withAllToolsEnabled } from "../src";

const repoSkills = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../skills");

describe("parseSkillMd", () => {
  it("reports frontmatter problems with their field path", () => {
    expect(() => parseSkillMd("---\nname: x\n---\nbody")).toThrow(/description/);
    expect(() => parseSkillMd("no frontmatter")).toThrow(/frontmatter/);
  });

  it("refuses a disabled tool the skill does not declare", () => {
    const md = (extra: string) =>
      `---\nname: x-skill\ndescription: ${"d".repeat(40)}\nversion: 0.1.0\nowner: "@t"\ntools: [ns_a]\n${extra}writes: false\n` +
      "platform: true\ngovernance_budget: { max_calls_per_invocation: 1, max_concurrency: 1 }\n---\nbody";
    expect(() => parseSkillMd(md("disabled_tools: [ns_b]\n"))).toThrow(/ns_b is not in tools/);
    expect(parseSkillMd(md("disabled_tools: [ns_a]\n")).manifest.disabled_tools).toEqual(["ns_a"]);
  });
});

describe("declaredTools", () => {
  it("leaves out disabled tools, which tool evals switch back on", () => {
    const skill = parseSkillMd(
      `---\nname: x-skill\ndescription: ${"d".repeat(40)}\nversion: 0.1.0\nowner: "@t"\ntools: [ns_a, ns_b]\n` +
        "disabled_tools: [ns_b]\nwrites: false\nplatform: true\ngovernance_budget: { max_calls_per_invocation: 1, max_concurrency: 1 }\n---\nbody",
    );
    const skills = [{ dir: "/x", ...skill }];
    expect([...declaredTools(skills)]).toEqual(["ns_a"]);
    expect([...declaredTools(withAllToolsEnabled(skills))]).toEqual(["ns_a", "ns_b"]);
  });
});

describe("repository skills", () => {
  it("all load, match their folders and only declare tools the gateway has", async () => {
    const skills = await loadSkills(repoSkills);
    expect(skills.map((s) => s.manifest.name)).toContain("data-explorer");
    const known = new Set(ALL_TOOLS.map((t) => t.name));
    for (const s of skills) for (const t of s.manifest.tools) expect(known, `${s.manifest.name} -> ${t}`).toContain(t);
  });

  it("honours the NS_AGENT_SKILLS allow-list", async () => {
    const skills = await loadSkills(repoSkills);
    expect(selectSkills(skills, "data-explorer").map((s) => s.manifest.name)).toEqual(["data-explorer"]);
  });
});
