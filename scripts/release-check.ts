/**
 * pnpm release:check
 * Runs every release gate in order and writes one evidence report to release-reports/.
 * Attach the report to the checkpoint row in the delivery plan.
 *
 * Gates: offline checks -> ns:ping -> contract tests (fixtures required) -> tool evals -> load test.
 */
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireLiveTarget } from "./lib/target";

const target = requireLiveTarget("release:check");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(repoRoot, "release-reports", stamp);
await mkdir(outDir, { recursive: true });

interface Gate {
  name: string;
  args: string[];
  env?: Record<string, string>;
  report?: string;
}

const gates: Gate[] = [
  { name: "offline checks (typecheck, unit tests, skills validation)", args: ["check"] },
  { name: "ns:ping (token, SuiteQL, metadata, RESTlet)", args: ["ns:ping"] },
  { name: "contract tests (recorded responses)", args: ["test:contract"], env: { RELEASE_CHECK: "1" } },
  {
    name: "tool evals (every kind: tool case)",
    args: ["skills:eval", "--mode", "tools", "--report", path.join(outDir, "evals.json")],
    report: "evals.json",
  },
  { name: "load test", args: ["load:test", "--report", path.join(outDir, "load.json")], report: "load.json" },
];

const results: Array<{ gate: string; pass: boolean; exitCode: number | null; seconds: number; report?: unknown }> = [];

for (const gate of gates) {
  console.log(`\n=== ${gate.name}`);
  const t0 = Date.now();
  const run = spawnSync("pnpm", ["-s", ...gate.args], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...gate.env, TURBO_TELEMETRY_DISABLED: "1" },
  });
  let report: unknown;
  if (gate.report) report = await readFile(path.join(outDir, gate.report), "utf8").then(JSON.parse, () => undefined);
  const pass = run.status === 0;
  results.push({ gate: gate.name, pass, exitCode: run.status, seconds: Math.round((Date.now() - t0) / 1000), report });
  if (!pass) {
    console.log(`\nGate failed: ${gate.name}. Later gates were not run.`);
    break;
  }
}

const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim() || "uncommitted";
const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim().length > 0;
const pass = results.length === gates.length && results.every((r) => r.pass);
const summary = {
  pass,
  target,
  accountId: process.env.NS_ACCOUNT_ID,
  commit,
  dirtyWorkingTree: dirty,
  ranAt: new Date().toISOString(),
  gates: results,
};
await writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));

console.log("\n=== Release check summary");
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.gate} (${r.seconds}s)`);
for (const g of gates.slice(results.length)) console.log(`SKIP  ${g.name}`);
if (dirty) console.log("\nNote: the working tree has uncommitted changes; commit before using this as release evidence.");
console.log(`\n${pass ? "RELEASE CHECK PASSED" : "RELEASE CHECK FAILED"} -> ${path.relative(repoRoot, outDir)}/summary.json`);
process.exit(pass ? 0 : 1);
