import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { TaskEvals, TriggerEvals } from "@ns-agent/schemas";
import { parse as parseYaml } from "yaml";
import type { ToolDef } from "./registry";
import { loadSkills, type LoadedSkill } from "./skills";

export interface Issue {
  skill: string;
  message: string;
}

export interface ValidationReport {
  skills: string[];
  errors: Issue[];
  warnings: Issue[];
}

/** Content that must never sit in a skill folder (keys, tokens, real account hosts). */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, "a bearer token"],
  [/\b\d{5,9}(?:[-_]sb\d+)?\.(?:suitetalk|restlets|app)\.(?:api\.)?netsuite\.com/i, "a real NetSuite account hostname"],
  [/\b(?:client_secret|token_secret|consumer_secret)\s*[:=]\s*\S{8,}/i, "a client or token secret"],
];

async function readYaml(file: string): Promise<unknown> {
  return parseYaml(await readFile(file, "utf8"));
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

/**
 * The CI gate behind `pnpm skills:validate`. Enabled skills must meet every rule (errors);
 * skills with `enabled: false` are under construction and get warnings instead.
 */
export async function validateSkills(repoRoot: string, tools: ToolDef[]): Promise<ValidationReport> {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const skillsDir = path.join(repoRoot, "skills");

  let skills: LoadedSkill[];
  try {
    skills = await loadSkills(skillsDir);
  } catch (error) {
    return { skills: [], errors: [{ skill: "(load)", message: (error as Error).message }], warnings };
  }

  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const codeowners = existsSync(path.join(repoRoot, ".github/CODEOWNERS"))
    ? await readFile(path.join(repoRoot, ".github/CODEOWNERS"), "utf8")
    : "";
  const routedBy = new Map<string, string>();

  for (const skill of skills) {
    const m = skill.manifest;
    const strict = m.enabled;
    const report = (message: string, alwaysError = false) =>
      (strict || alwaysError ? errors : warnings).push({ skill: m.name, message });

    // Tools: exist, and write flags agree with the manifest.
    for (const name of m.tools) {
      const tool = toolMap.get(name);
      if (!tool) report(`declares tool ${name}, which the gateway does not have`, true);
      else if (tool.writes && !m.writes) report(`declares write tool ${name} but has writes: false`, true);
    }
    if (m.writes && !m.platform && !m.tools.some((t) => toolMap.get(t)?.writes)) {
      report("has writes: true but declares no write tool");
    }
    if (m.deprecated) warnings.push({ skill: m.name, message: `deprecated; replacement is ${m.replacement}` });

    // Evals.
    const triggersFile = path.join(skill.dir, "evals/triggers.yaml");
    const tasksFile = path.join(skill.dir, "evals/tasks.yaml");
    if (!existsSync(triggersFile)) report("missing evals/triggers.yaml");
    else {
      const parsed = TriggerEvals.safeParse(await readYaml(triggersFile));
      if (!parsed.success) report(`evals/triggers.yaml: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      else {
        for (const prompt of parsed.data.should_route) {
          const key = prompt.trim().toLowerCase();
          const other = routedBy.get(key);
          if (other) report(`trigger prompt "${prompt}" also routes to ${other}; skills must not overlap`, true);
          routedBy.set(key, m.name);
        }
      }
    }
    if (!existsSync(tasksFile)) report("missing evals/tasks.yaml");
    else {
      const parsed = TaskEvals.safeParse(await readYaml(tasksFile));
      if (!parsed.success) report(`evals/tasks.yaml: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      else {
        const ids = new Set<string>();
        for (const c of parsed.data.cases) {
          if (ids.has(c.id)) report(`duplicate eval case id ${c.id}`, true);
          ids.add(c.id);
          if (c.kind === "tool" && !m.tools.includes(c.tool)) report(`eval ${c.id} calls ${c.tool}, which the skill does not declare`, true);
          if (c.kind === "agent") {
            for (const t of [...c.expect_tools, ...c.forbid_tools]) {
              if (!toolMap.has(t)) report(`eval ${c.id} references unknown tool ${t}`, true);
            }
          }
        }
        const writeTools = m.tools.filter((t) => toolMap.get(t)?.writes);
        for (const wt of writeTools) {
          const proven = parsed.data.cases.some((c) => c.kind === "tool" && c.tool === wt && c.expect.ok === false);
          if (!proven) report(`write tool ${wt} has no eval proving it is blocked without approval`);
        }
      }
    }

    // Ownership and documentation.
    const owners = existsSync(path.join(skill.dir, "OWNERS"))
      ? (await readFile(path.join(skill.dir, "OWNERS"), "utf8")).split("\n").filter((l) => l.trim().startsWith("@"))
      : [];
    if (owners.length === 0) report("OWNERS lists no owner");
    const changelog = existsSync(path.join(skill.dir, "CHANGELOG.md"))
      ? await readFile(path.join(skill.dir, "CHANGELOG.md"), "utf8")
      : "";
    if (!changelog.includes(`## ${m.version}`)) report(`CHANGELOG.md has no entry for version ${m.version}`);
    if (!codeowners.includes(`/skills/${m.name}/`)) report(`.github/CODEOWNERS has no line for /skills/${m.name}/`);
    if (!m.platform) {
      const examplesDir = path.join(skill.dir, "examples");
      const examples = existsSync(examplesDir) ? (await readdir(examplesDir)).filter((f) => f.endsWith(".md")) : [];
      if (examples.length < 3) report(`needs at least 3 examples (has ${examples.length})`);
    }
    if (/\[FILL[:\]]/.test(skill.body) || /\[FILL[:\]]/.test(m.description)) report("SKILL.md still has [FILL] placeholders in its instructions");

    // Data hygiene: always an error, enabled or not.
    for (const file of await listFiles(skill.dir)) {
      const text = await readFile(file, "utf8");
      for (const [pattern, what] of SECRET_PATTERNS) {
        if (pattern.test(text)) report(`${path.relative(skill.dir, file)} appears to contain ${what}`, true);
      }
    }
  }

  return { skills: skills.map((s) => s.manifest.name), errors, warnings };
}
