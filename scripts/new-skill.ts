/**
 * pnpm new:skill <name> [--writes]
 * Scaffolds skills/<name> from skills/_template, adds a tool module stub to the gateway,
 * and adds a CODEOWNERS line. The new skill starts with enabled: false.
 */
import { existsSync } from "node:fs";
import { appendFile, cp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_NAME } from "@ns-agent/schemas";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith("--"));
const writes = args.includes("--writes");

function fail(message: string): never {
  console.error(`new-skill: ${message}`);
  process.exit(1);
}

if (!name) fail("usage: pnpm new:skill <kebab-case-name> [--writes]");
if (!SKILL_NAME.test(name)) fail(`"${name}" must be kebab-case, 2-63 characters, starting with a letter`);

const skillDir = path.join(repoRoot, "skills", name);
const toolFile = path.join(repoRoot, "apps/mcp-gateway/src/tools", `${name}.ts`);
if (existsSync(skillDir)) fail(`skills/${name} already exists; improve it instead of creating a new one`);
if (existsSync(toolFile)) fail(`apps/mcp-gateway/src/tools/${name}.ts already exists`);

const title = name
  .split("-")
  .map((w) => w[0]!.toUpperCase() + w.slice(1))
  .join(" ");
const camel = name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

// 1. Copy the template and fill its placeholders.
await cp(path.join(repoRoot, "skills/_template"), skillDir, { recursive: true });
async function fillPlaceholders(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await fillPlaceholders(full);
    else if (/\.(md|yaml)$|^OWNERS$/.test(entry.name)) {
      const text = await readFile(full, "utf8");
      await writeFile(
        full,
        text.replaceAll("{{name}}", name!).replaceAll("{{title}}", title).replaceAll("{{writes}}", String(writes)),
      );
    }
  }
}
await fillPlaceholders(skillDir);

// 2. Tool module stub, registered in tools/index.ts.
await writeFile(
  toolFile,
  `import type { ToolDef } from "../registry";

/**
 * Tools for the ${name} skill. Define each with defineTool() from "../registry",
 * add it to this list, and declare it in skills/${name}/SKILL.md under \`tools\`.
 * Write tools must set \`writes: true\`; the gateway then routes them through approvals.
 */
export const ${camel}Tools: ToolDef[] = [];
`,
);
const indexFile = path.join(repoRoot, "apps/mcp-gateway/src/tools/index.ts");
let index = await readFile(indexFile, "utf8");
index = index
  .replace("// new-skill:imports", `import { ${camel}Tools } from "./${name}";\n// new-skill:imports`)
  .replace("  // new-skill:tools", `  ...${camel}Tools,\n  // new-skill:tools`);
await writeFile(indexFile, index);

// 3. Ownership.
const ownerPath = `/skills/${name}/`;
await appendFile(
  path.join(repoRoot, ".github/CODEOWNERS"),
  `${ownerPath}${" ".repeat(Math.max(1, 36 - ownerPath.length))}@[FILL:${name}-owner]\n`,
);

console.log(`Created skills/${name} (enabled: false) and apps/mcp-gateway/src/tools/${name}.ts.

Next, in this order (docs/skill-lifecycle.md):
  1. Write evals first: skills/${name}/evals/triggers.yaml and tasks.yaml
  2. Write SKILL.md instructions and at least 3 examples
  3. Build the tools in apps/mcp-gateway/src/tools/${name}.ts and list them in SKILL.md
  4. pnpm skills:validate   (warnings until enabled; errors once enabled: true)
  5. Fill the owner handles in OWNERS and .github/CODEOWNERS`);
