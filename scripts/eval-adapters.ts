/**
 * Agent host for agent and trigger evals: headless Claude Code (`claude -p`).
 *
 * - run(): Claude gets the enabled skills as its system prompt and the gateway as its only MCP server
 *   (no built-in tools), with NS_AGENT_WRITES=request-only: write tools return a real approval_pending
 *   preview, but nobody can approve, so no write can run. When the agent ends a turn asking the user to
 *   confirm, a simulated user answers "Yes, go ahead." (never "approved"), up to 2 times. Tool calls are
 *   read from the stream-json transcript. Sessions live in a temp folder and are removed afterwards.
 * - judge(): a second `claude -p` call grades the transcript against the case rubric and returns JSON.
 * - route(): one `claude -p` call classifies a batch of prompts to skill names.
 *
 * Needs the `claude` CLI logged in. Costs model usage: roughly $0.10-0.50 per agent case.
 */
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { LoadedSkill } from "@ns-agent/mcp-gateway";
import { tempSdfProject } from "./lib/eval-sdf";

export interface AgentRun {
  /** Agent replies and simulated user replies, in order. */
  turns: Array<{ role: "agent" | "user"; text: string }>;
  /** Gateway tool names called, in order (without the mcp__ prefix). */
  toolsCalled: string[];
  /** Tool calls with their inputs, for the judge. */
  calls: Array<{ tool: string; input: unknown }>;
  /** The final answer shown to the user. */
  answer: string;
  costUsd: number;
}

export interface Verdict {
  pass: boolean;
  reason: string;
  costUsd: number;
}

export interface AgentHostAdapter {
  /** Throws with setup instructions when the adapter is not configured. */
  assertConfigured(): Promise<void>;
  /** For each prompt, which skill the host would load, or null for none. */
  route(prompts: string[]): Promise<Array<string | null>>;
  /** Runs the prompt end to end against the gateway, read-only. */
  run(prompt: string): Promise<AgentRun>;
  /** Grades a run against a rubric. */
  judge(prompt: string, rubric: string, run: AgentRun): Promise<Verdict>;
}

const SERVER = "netsuite-agent";
const TIMEOUT_MS = 6 * 60_000;

function claude(args: string[], timeoutMs = TIMEOUT_MS, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], cwd });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude -p timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude -p exited ${code}: ${err.trim().slice(0, 300)}`));
    });
  });
}

/** Parses the JSON object a model reply contains (tolerates prose or code fences around it). */
function jsonIn(text: string): unknown {
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (start < 0 || end < start) throw new Error(`no JSON in reply: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

const BASE_FLAGS = ["--no-session-persistence", "--tools", ""];
const MAX_SIMULATED_REPLIES = 2;
/** What the simulated user says when the agent asks to confirm. It never claims an approval was given. */
const SIMULATED_REPLY = "Yes, go ahead.";

/** True when the agent's last reply ends by asking the user to confirm or choose. */
export function asksToConfirm(answer: string): boolean {
  const tail = answer.trim().split("\n").slice(-4).join(" ").toLowerCase();
  return (
    /\?\s*(\*\*)?$/.test(answer.trim()) ||
    /\b(shall i|should i|do you want|would you like|want me to|confirm|ok to proceed|go ahead|let me know|tell me|once you|if you agree|reply)\b/.test(tail)
  );
}

export class ClaudeCodeAdapter implements AgentHostAdapter {
  constructor(
    private readonly repoRoot: string,
    /** Every skill: enabled ones are loaded as instructions; user-facing ones are routing targets. */
    private readonly skills: LoadedSkill[],
  ) {}

  async assertConfigured(): Promise<void> {
    try {
      await claude(["--version"], 30_000);
    } catch {
      console.error("Agent evals need the Claude Code CLI (`claude`) on PATH and logged in. Tool evals (--mode tools) do not.");
      process.exit(2);
    }
  }

  private systemPrompt(): string {
    const enabled = this.skills.filter((s) => s.manifest.enabled && !s.manifest.deprecated);
    return [
      "You are an assistant working in a NetSuite account through the netsuite-agent gateway tools.",
      "Follow the skills below. Pick the skill whose description fits the request.",
      "Never claim an approval was given unless a tool result says so.",
      "",
      ...enabled.map((s) => `<skill name="${s.manifest.name}">\n${s.manifest.description}\n\n${s.body.trim()}\n</skill>`),
    ].join("\n");
  }

  async run(prompt: string): Promise<AgentRun> {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "ns-agent-eval-")));
    try {
      const mcp = path.join(dir, "mcp.json");
      await writeFile(
        mcp,
        JSON.stringify({
          mcpServers: {
            [SERVER]: {
              command: "sh",
              args: [path.join(this.repoRoot, "scripts/mcp-gateway.sh")],
              env: {
                NS_AGENT_WRITES: "request-only",
                NS_AGENT_APPROVALS_DB: path.join(dir, "approvals.sqlite"),
                // Same synthetic files as the tool evals; exports go to the temp folder and are removed.
                NS_AGENT_IMPORT_DIR: path.join(this.repoRoot, "skills/data-importer/evals/fixtures"),
                NS_AGENT_EXPORT_DIR: path.join(dir, "exports"),
                NS_AGENT_SDF_DIR: await tempSdfProject(this.repoRoot, dir),
              },
            },
          },
        }),
      );
      const flags = [
        "--output-format", "stream-json", "--verbose",
        "--mcp-config", mcp, "--strict-mcp-config",
        "--allowedTools", `mcp__${SERVER}`,
        "--system-prompt", this.systemPrompt(),
        "--tools", "",
      ];
      const run: AgentRun = { turns: [], toolsCalled: [], calls: [], answer: "", costUsd: 0 };
      let sessionId: string | undefined;
      let message = prompt;
      for (let turn = 0; turn < 1 + MAX_SIMULATED_REPLIES; turn++) {
        const out = await claude(["-p", message, ...flags, ...(sessionId ? ["--resume", sessionId] : [])], TIMEOUT_MS, dir);
        for (const line of out.split("\n")) {
          if (!line.trim().startsWith("{")) continue;
          const m = JSON.parse(line) as {
            type: string;
            session_id?: string;
            message?: { content?: Array<{ type: string; name?: string; input?: unknown }> };
            result?: string;
            total_cost_usd?: number;
          };
          sessionId = m.session_id ?? sessionId;
          if (m.type === "assistant") {
            for (const b of m.message?.content ?? []) {
              if (b.type === "tool_use" && b.name?.startsWith(`mcp__${SERVER}__`)) {
                run.calls.push({ tool: b.name.slice(`mcp__${SERVER}__`.length), input: b.input });
              }
            }
          } else if (m.type === "result") {
            run.answer = m.result ?? "";
            run.costUsd += m.total_cost_usd ?? 0;
          }
        }
        run.turns.push({ role: "agent", text: run.answer });
        if (!sessionId || !asksToConfirm(run.answer)) break;
        message = SIMULATED_REPLY;
        run.turns.push({ role: "user", text: message });
      }
      run.toolsCalled = run.calls.map((c) => c.tool);
      return run;
    } finally {
      await rm(dir, { recursive: true, force: true });
      // claude stores sessions per working folder; remove the one this run created.
      const slug = dir.replace(/[^A-Za-z0-9]/g, "-");
      if (slug.includes("ns-agent-eval-")) await rm(path.join(homedir(), ".claude", "projects", slug), { recursive: true, force: true });
    }
  }

  async judge(prompt: string, rubric: string, run: AgentRun): Promise<Verdict> {
    const transcript = run.calls.map((c, i) => `${i + 1}. ${c.tool} ${JSON.stringify(c.input).slice(0, 800)}`).join("\n") || "(no tool calls)";
    const conversation = run.turns.map((t) => `${t.role === "agent" ? "AGENT" : "USER"}: ${t.text.slice(0, 3000)}`).join("\n\n");
    const out = await claude([
      "-p",
      [
        "Grade an AI agent's run against a rubric. The agent works in NetSuite through gateway tools.",
        "The user's follow-up replies were simulated and only ever said \"Yes, go ahead.\"; no approval was ever given.",
        "Write tools in this run could only return approval_pending; nothing can be approved or written.",
        'Reply with only JSON: {"pass": true|false, "reason": "<one sentence>"}.',
        "",
        `User prompt: ${prompt}`,
        `Rubric: ${rubric}`,
        `Tool calls:\n${transcript}`,
        `Conversation:\n${conversation}`,
      ].join("\n"),
      "--output-format", "json",
      ...BASE_FLAGS,
    ]);
    const wrapper = JSON.parse(out) as { result?: string; total_cost_usd?: number };
    const verdict = jsonIn(wrapper.result ?? "") as { pass?: unknown; reason?: unknown };
    return { pass: verdict.pass === true, reason: String(verdict.reason ?? ""), costUsd: wrapper.total_cost_usd ?? 0 };
  }

  async route(prompts: string[]): Promise<Array<string | null>> {
    const targets = this.skills.filter((s) => !s.manifest.platform && !s.manifest.deprecated);
    const out = await claude([
      "-p",
      [
        "You route user requests to skills. Skills:",
        ...targets.map((s) => `- ${s.manifest.name}: ${s.manifest.description}`),
        "",
        "For each numbered request, give the one skill that should handle it, or null if none fits.",
        'Reply with only a JSON array of skill names or null, in order, e.g. ["reports", null].',
        "",
        ...prompts.map((p, i) => `${i + 1}. ${p}`),
      ].join("\n"),
      "--output-format", "json",
      ...BASE_FLAGS,
    ]);
    const wrapper = JSON.parse(out) as { result?: string };
    const routed = jsonIn(wrapper.result ?? "") as unknown[];
    if (!Array.isArray(routed) || routed.length !== prompts.length) throw new Error("router returned the wrong number of answers");
    const names = new Set(targets.map((s) => s.manifest.name));
    return routed.map((r) => (typeof r === "string" && names.has(r) ? r : null));
  }
}

export function agentHostAdapter(repoRoot: string, skills: LoadedSkill[]): AgentHostAdapter {
  return new ClaudeCodeAdapter(repoRoot, skills);
}
