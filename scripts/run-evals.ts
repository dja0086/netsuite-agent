/**
 * pnpm skills:eval --mode tools|agent|triggers [--skill <name>] [--threshold 0.9] [--report <file>]
 *
 * tools:    every `kind: tool` case through the real gateway (policy, redaction, audit) against NS_ACCOUNT_ID.
 * agent:    every `kind: agent` case end to end through the agent host (scripts/eval-adapters.ts, read-only
 *           gateway), checked for expect_tools / forbid_tools and graded against its rubric.
 * triggers: every should_route / should_not_route prompt routed by the agent host; thresholds from
 *           docs/skill-lifecycle.md (>= 95% routed here, <= 3% of other skills' prompts claimed).
 * Requires NS_TARGET_KIND=sandbox|demo (see scripts/lib/target.ts).
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
  withAllToolsEnabled,
} from "@ns-agent/mcp-gateway";
import { NsClient } from "@ns-agent/ns-client";
import { TaskEvals, TriggerEvals, type TaskCase } from "@ns-agent/schemas";
import { parse as parseYaml } from "yaml";
import { agentHostAdapter } from "./eval-adapters";
import { tempSdfProject } from "./lib/eval-sdf";
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
  // Import evals read only the synthetic fixtures, never files a user staged in ./imports.
  process.env.NS_AGENT_IMPORT_DIR = path.join(repoRoot, "skills/data-importer/evals/fixtures");
  // Generated SDF objects go to a throwaway project, never netsuite/src.
  process.env.NS_AGENT_SDF_DIR = await tempSdfProject(repoRoot);
  const ns = NsClient.fromEnv();
  const { server } = createGateway({
    ns,
    skills: withAllToolsEnabled(skills),
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

async function runAgentEvals(): Promise<CaseResult[]> {
  const all = await loadSkills(path.join(repoRoot, "skills"));
  const adapter = agentHostAdapter(repoRoot, all);
  await adapter.assertConfigured();
  const results: CaseResult[] = [];
  let cost = 0;
  for (const skill of all.filter((s) => !only || s.manifest.name === only)) {
    const parsed = TaskEvals.safeParse(parseYaml(await readFile(path.join(skill.dir, "evals/tasks.yaml"), "utf8")));
    if (!parsed.success) continue;
    for (const c of parsed.data.cases) {
      if (c.kind !== "agent") continue;
      const started = Date.now();
      let failure: string | undefined;
      try {
        const run = await adapter.run(c.prompt);
        cost += run.costUsd;
        const missing = c.expect_tools.filter((t) => !run.toolsCalled.includes(t));
        const forbidden = c.forbid_tools.filter((t) => run.toolsCalled.includes(t));
        const last = run.answer.replace(/\s+/g, " ").slice(-240);
        if (missing.length) failure = `did not call ${missing.join(", ")} (called: ${run.toolsCalled.join(", ") || "none"}; ${run.turns.length} turns; last reply ends: "${last}")`;
        else if (forbidden.length) failure = `called forbidden ${forbidden.join(", ")}`;
        else {
          const verdict = await adapter.judge(c.prompt, c.rubric, run);
          cost += verdict.costUsd;
          if (!verdict.pass) failure = `rubric: ${verdict.reason}`;
        }
      } catch (error) {
        failure = `error: ${(error as Error).message}`;
      }
      results.push({ skill: skill.manifest.name, id: c.id, passed: !failure, safety: false, detail: failure ?? "ok", ms: Date.now() - started });
      console.log(`${failure ? "FAIL" : "pass"}  ${skill.manifest.name}/${c.id}  ${failure ?? ""}`);
    }
  }
  console.log(`(model cost about $${cost.toFixed(2)})`);
  return results;
}

async function runTriggerEvals(): Promise<{ results: CaseResult[]; failed: boolean }> {
  const all = await loadSkills(path.join(repoRoot, "skills"));
  const adapter = agentHostAdapter(repoRoot, all);
  await adapter.assertConfigured();
  const results: CaseResult[] = [];
  let failed = false;
  for (const skill of all.filter((s) => !s.manifest.platform && (!only || s.manifest.name === only))) {
    const parsed = TriggerEvals.safeParse(parseYaml(await readFile(path.join(skill.dir, "evals/triggers.yaml"), "utf8")));
    if (!parsed.success) continue;
    const prompts = [...parsed.data.should_route, ...parsed.data.should_not_route];
    const routed = await adapter.route(prompts);
    const name = skill.manifest.name;
    prompts.forEach((p, i) => {
      const should = i < parsed.data.should_route.length;
      const ok = should ? routed[i] === name : routed[i] !== name;
      results.push({ skill: name, id: `${should ? "route" : "not"}: ${p}`, passed: ok, safety: false, detail: `routed to ${routed[i] ?? "none"}`, ms: 0 });
      if (!ok) console.log(`FAIL  ${name}  ${should ? "should route" : "should not route"}: "${p}" -> ${routed[i] ?? "none"}`);
    });
    const hit = parsed.data.should_route.filter((_, i) => routed[i] === name).length / parsed.data.should_route.length;
    const claimed = parsed.data.should_not_route.filter((_, i) => routed[parsed.data.should_route.length + i] === name).length / parsed.data.should_not_route.length;
    const pass = hit >= 0.95 && claimed <= 0.03;
    if (!pass) failed = true;
    console.log(`${pass ? "pass" : "FAIL"}  ${name}: routed ${(hit * 100).toFixed(0)}% of its prompts, claimed ${(claimed * 100).toFixed(0)}% of others`);
  }
  return { results, failed };
}

requireLiveTarget("skills:eval");
if (mode === "triggers") {
  const { results, failed } = await runTriggerEvals();
  if (reportFile) await writeFile(reportFile, JSON.stringify({ mode, results }, null, 2));
  process.exit(failed ? 1 : 0);
}
if (mode !== "tools" && mode !== "agent") {
  console.error(`Unknown mode "${mode}"; use tools, agent or triggers.`);
  process.exit(2);
}
const results = mode === "agent" ? await runAgentEvals() : await runToolEvals();
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
