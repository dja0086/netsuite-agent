import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_TOOLS, loadSkills, parseSkillMd, selectSkills } from "../src";

const repoSkills = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../skills");

describe("parseSkillMd", () => {
  it("reports frontmatter problems with their field path", () => {
    expect(() => parseSkillMd("---\nname: x\n---\nbody")).toThrow(/description/);
    expect(() => parseSkillMd("no frontmatter")).toThrow(/frontmatter/);
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
