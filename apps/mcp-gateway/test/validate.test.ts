import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ALL_TOOLS, defineTool, validateSkills, type ToolDef } from "../src";

const writeTool = defineTool({
  name: "ns_thing_save",
  title: "Save a thing",
  description: "test write tool",
  writes: true,
  input: z.object({}),
  handler: async () => ({}),
}) as unknown as ToolDef;
const TOOLS = [...ALL_TOOLS, writeTool];

interface SkillSpec {
  name: string;
  frontmatter?: Record<string, unknown>;
  body?: string;
  triggers?: string;
  tasks?: string;
  examples?: number;
  owners?: string;
  changelogVersion?: string;
  extraFiles?: Record<string, string>;
}

const goodTriggers = (tag: string) =>
  `should_route:\n${[1, 2, 3, 4, 5].map((i) => `  - ${tag} prompt number ${i}`).join("\n")}\nshould_not_route:\n  - other one\n  - other two\n  - other three\n`;
const goodTasks = `cases:
  - { kind: tool, id: a, tool: ns_suiteql, input: { q: "SELECT 1 FROM DUAL" }, expect: { min_rows: 1 } }
  - { kind: tool, id: b, tool: ns_suiteql, input: { q: "DELETE x" }, expect: { ok: false } }
  - { kind: agent, id: c, prompt: "How many customers?", expect_tools: [ns_suiteql], rubric: "Gives a count" }
`;

async function repo(specs: SkillSpec[], codeownersFor = specs.map((s) => s.name)): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "skills-validate-"));
  await mkdir(path.join(root, ".github"), { recursive: true });
  await writeFile(path.join(root, ".github/CODEOWNERS"), codeownersFor.map((n) => `/skills/${n}/ @x`).join("\n"));
  for (const s of specs) {
    const dir = path.join(root, "skills", s.name);
    await mkdir(path.join(dir, "evals"), { recursive: true });
    await mkdir(path.join(dir, "examples"), { recursive: true });
    const fm = {
      name: s.name,
      description: "A skill used in validator tests; long enough to pass the schema.",
      version: "1.0.0",
      owner: "@x",
      tools: ["ns_suiteql"],
      writes: false,
      governance_budget: { max_calls_per_invocation: 5, max_concurrency: 1 },
      ...s.frontmatter,
    };
    await writeFile(path.join(dir, "SKILL.md"), `---\n${JSON.stringify(fm)}\n---\n${s.body ?? "# Skill\n"}`);
    await writeFile(path.join(dir, "evals/triggers.yaml"), s.triggers ?? goodTriggers(s.name));
    await writeFile(path.join(dir, "evals/tasks.yaml"), s.tasks ?? goodTasks);
    for (let i = 0; i < (s.examples ?? 3); i++) await writeFile(path.join(dir, `examples/e${i}.md`), "example");
    await writeFile(path.join(dir, "OWNERS"), s.owners ?? "@x\n");
    await writeFile(path.join(dir, "CHANGELOG.md"), `## ${s.changelogVersion ?? "1.0.0"}\n`);
    for (const [file, text] of Object.entries(s.extraFiles ?? {})) await writeFile(path.join(dir, file), text);
  }
  return root;
}

const messages = (issues: Array<{ message: string }>) => issues.map((i) => i.message).join(" | ");

describe("validateSkills", () => {
  it("passes a complete skill", async () => {
    const report = await validateSkills(await repo([{ name: "good-skill" }]), TOOLS);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it("flags unknown tools and write tools on a read-only skill", async () => {
    const report = await validateSkills(
      await repo([{ name: "bad-tools", frontmatter: { tools: ["ns_suiteql", "ns_nope", "ns_thing_save"] } }]),
      TOOLS,
    );
    expect(messages(report.errors)).toMatch(/ns_nope/);
    expect(messages(report.errors)).toMatch(/write tool ns_thing_save but has writes: false/);
  });

  it("requires a blocked-without-approval eval for each write tool", async () => {
    const report = await validateSkills(
      await repo([{ name: "writer", frontmatter: { tools: ["ns_suiteql", "ns_thing_save"], writes: true } }]),
      TOOLS,
    );
    expect(messages(report.errors)).toMatch(/ns_thing_save has no eval proving it is blocked/);
  });

  it("enforces examples, owners, changelog, codeowners and placeholders", async () => {
    const report = await validateSkills(
      await repo(
        [{ name: "thin", examples: 1, owners: "# nobody\n", changelogVersion: "0.9.0", body: "Do [FILL: this]" }],
        [],
      ),
      TOOLS,
    );
    const text = messages(report.errors);
    for (const expected of [/at least 3 examples/, /OWNERS/, /CHANGELOG/, /CODEOWNERS/, /\[FILL\]/]) expect(text).toMatch(expected);
  });

  it("downgrades rule failures to warnings while a skill is disabled, but not secrets", async () => {
    const report = await validateSkills(
      await repo([
        {
          name: "wip",
          frontmatter: { enabled: false, tools: [] },
          examples: 0,
          triggers: "should_route: []\nshould_not_route: []\n",
          tasks: "cases: []\n",
          // Built from parts so secret scanners do not flag this test fixture.
          extraFiles: { "notes.md": ["-----BEGIN", "PRIVATE KEY-----\nabc"].join(" ") },
        },
      ]),
      TOOLS,
    );
    expect(messages(report.warnings)).toMatch(/examples/);
    expect(messages(report.errors)).toMatch(/private key/);
    expect(report.errors).toHaveLength(1);
  });

  it("rejects trigger prompts claimed by two skills", async () => {
    const shared = goodTriggers("shared");
    const report = await validateSkills(await repo([{ name: "one-skill", triggers: shared }, { name: "two-skill", triggers: shared }]), TOOLS);
    expect(messages(report.errors)).toMatch(/also routes to one-skill/);
  });

  it("flags real account hostnames", async () => {
    const report = await validateSkills(
      await repo([{ name: "leaky", extraFiles: { "notes.md": "see https://1234567.suitetalk.api.netsuite.com/services" } }]),
      TOOLS,
    );
    expect(messages(report.errors)).toMatch(/account hostname/);
  });
});
