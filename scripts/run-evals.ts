/**
 * pnpm skills:eval --mode tools [--skill <name>] [--threshold 0.9] [--report <file>]
 *
 * Tool mode runs every `kind: tool` case through the real gateway (policy, redaction, audit)
 * against the account in NS_ACCOUNT_ID. Requires NS_TARGET_KIND=sandbox|demo (see scripts/lib/target.ts).
 * Agent and trigger evals need an agent host; see scripts/eval-adapters.ts.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  DenyAllApprovals,
  MemoryAuditSink,
  createGateway,
  loadSkills,
  redactFieldsFromEnv,
} from "@ns-agent/mcp-gateway";
import { NsClient } from "@ns-agent/ns-client";
import { TaskEvals, type TaskCase } from "@ns-agent/schemas";
import { parse as parseYaml } from "yaml";
import { agentHostAdapter } from "./eval-adapters";
import { requireLiveTarget } from "./lib/target";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const mode = flag("mode", "tools");
const only = flag("skill");
const threshold = Number(flag("threshold", "0.9"));
const reportFile = flag("report");

interface CaseResult {
  skill: string;
  id: string;
  passed: boolean;
  safety: boolean;
  detail: string;
  ms: number;
}

function check(c: Extract<TaskCase, { kind: "tool" }>, isError: boolean, text: string): string | undefined {
  const e = c.expect;
  if (e.ok && isError) return `expected success, got error: ${text.slice(0, 200)}`;
  if (!e.ok) {
    if (!isError) return "expected an error, got success";
    if (e.error_contains && !text.includes(e.error_contains)) return `error did not contain "${e.error_contains}": ${text.slice(0, 200)}`;
    return undefined;
  }
  const value = JSON.parse(text) as Record<string, unknown>;
  const rows = Array.isArray(value.rows) ? value.rows : undefined;
  if (e.min_rows !== undefined && (rows?.length ?? 0) < e.min_rows) return `expected >= ${e.min_rows} rows, got ${rows?.length ?? 0}`;
  if (e.max_rows !== undefined && (rows?.length ?? 0) > e.max_rows) return `expected <= ${e.max_rows} rows, got ${rows?.length}`;
  for (const key of e.has_keys ?? []) {
    const target = rows?.[0] && typeof rows[0] === "object" && !(key in value) ? (rows[0] as Record<string, unknown>) : value;
    if (!(key in target)) return `missing key "${key}"`;
  }
  return undefined;
}

async function runToolEvals(): Promise<CaseResult[]> {
  const skills = (await loadSkills(path.join(repoRoot, "skills"))).filter((s) => !only || s.manifest.name === only);
  const results: CaseResult[] = [];
  // Evals exercise every declared tool, including skills still disabled.
  const ns = NsClient.fromEnv();
  const { server } = createGateway({
    ns,
    skills,
    audit: new MemoryAuditSink(),
    // Evals never get an approval: every write tool must stay blocked here.
    approvals: new DenyAllApprovals(),
    redactFields: redactFieldsFromEnv(),
    accountId: ns.config.accountId,
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "skills-eval", version: "0.1.0" });
  await client.connect(clientT);

  for (const skill of skills) {
    const raw = parseYaml(await readFile(path.join(skill.dir, "evals/tasks.yaml"), "utf8"));
    const parsed = TaskEvals.safeParse(raw);
    if (!parsed.success) {
      results.push({ skill: skill.manifest.name, id: "(tasks.yaml)", passed: false, safety: false, detail: "invalid tasks.yaml", ms: 0 });
      continue;
    }
    for (const c of parsed.data.cases) {
      if (c.kind !== "tool") continue;
      const started = Date.now();
      const res = await client.callTool({ name: c.tool, arguments: c.input });
      const text = (res.content as Array<{ text?: string }>)[0]?.text ?? "";
      const failure = check(c, Boolean(res.isError), text);
      results.push({
        skill: skill.manifest.name,
        id: c.id,
        passed: !failure,
        safety: c.expect.ok === false,
        detail: failure ?? "ok",
        ms: Date.now() - started,
      });
      console.log(`${failure ? "FAIL" : "pass"}  ${skill.manifest.name}/${c.id}  ${failure ?? ""}`);
    }
  }
  await client.close();
  return results;
}

if (mode === "agent" || mode === "triggers") {
  await agentHostAdapter().assertConfigured();
}
if (mode !== "tools") {
  console.error(`Mode "${mode}" needs an agent host adapter. See scripts/eval-adapters.ts.`);
  process.exit(2);
}

requireLiveTarget("skills:eval");
const results = await runToolEvals();
const bySkill = new Map<string, CaseResult[]>();
for (const r of results) bySkill.set(r.skill, [...(bySkill.get(r.skill) ?? []), r]);

let failed = false;
const summary = [...bySkill].map(([skill, rs]) => {
  const rate = rs.filter((r) => r.passed).length / rs.length;
  const safetyFailed = rs.some((r) => r.safety && !r.passed);
  if (rate < threshold || safetyFailed) failed = true;
  return { skill, cases: rs.length, passRate: Number(rate.toFixed(3)), safetyFailed };
});
console.log("\n" + summary.map((s) => `${s.skill}: ${(s.passRate * 100).toFixed(0)}% of ${s.cases}${s.safetyFailed ? " (SAFETY CASE FAILED)" : ""}`).join("\n"));

if (reportFile) {
  await writeFile(reportFile, JSON.stringify({ mode, threshold, summary, results }, null, 2));
}
process.exit(failed ? 1 : 0);
