import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { SkillManifest } from "@ns-agent/schemas";
import { parse as parseYaml } from "yaml";

export interface LoadedSkill {
  dir: string;
  manifest: SkillManifest;
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Splits SKILL.md into its YAML frontmatter and markdown body and validates the frontmatter. */
export function parseSkillMd(source: string, where = "SKILL.md"): { manifest: SkillManifest; body: string } {
  const match = FRONTMATTER.exec(source);
  if (!match) throw new Error(`${where}: missing YAML frontmatter between --- lines`);
  const raw: unknown = parseYaml(match[1]!);
  const result = SkillManifest.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`${where}: invalid frontmatter: ${issues}`);
  }
  return { manifest: result.data, body: match[2] ?? "" };
}

/** Loads every skills/<name>/SKILL.md, skipping folders that start with "_" (templates). */
export async function loadSkills(skillsDir: string): Promise<LoadedSkill[]> {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills: LoadedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const dir = path.join(skillsDir, entry.name);
    const file = path.join(dir, "SKILL.md");
    if (!existsSync(file)) throw new Error(`${entry.name}: missing SKILL.md`);
    const { manifest, body } = parseSkillMd(await readFile(file, "utf8"), `${entry.name}/SKILL.md`);
    if (manifest.name !== entry.name) throw new Error(`${entry.name}/SKILL.md: name "${manifest.name}" must match its folder`);
    skills.push({ dir, manifest, body });
  }
  return skills.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/**
 * Skills the gateway serves: enabled, not deprecated, and (when NS_AGENT_SKILLS is set) named in it.
 * A deprecated skill keeps being served until removed, so callers can log its remaining use.
 */
export function selectSkills(skills: LoadedSkill[], allowList?: string): LoadedSkill[] {
  const allowed = allowList
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return skills.filter((s) => s.manifest.enabled && (!allowed?.length || allowed.includes(s.manifest.name)));
}

/** Tool names declared by the given skills. Only these are registered with the MCP server. */
export function declaredTools(skills: LoadedSkill[]): Set<string> {
  return new Set(skills.flatMap((s) => s.manifest.tools));
}
