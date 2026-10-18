/**
 * pnpm skills:validate
 * CI gate for skills: manifests, declared tools, write safety evals, owners, changelog, examples, secrets.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_TOOLS, validateSkills } from "@ns-agent/mcp-gateway";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const report = await validateSkills(repoRoot, ALL_TOOLS);

for (const w of report.warnings) console.log(`warn   ${w.skill}: ${w.message}`);
for (const e of report.errors) console.log(`error  ${e.skill}: ${e.message}`);
console.log(
  `\n${report.skills.length} skills checked (${report.skills.join(", ")}): ` +
    `${report.errors.length} errors, ${report.warnings.length} warnings`,
);
process.exit(report.errors.length ? 1 : 0);
