/**
 * Agent host for agent and trigger evals: headless Claude Code (`claude -p`).
 *
 * - run(): Claude gets the enabled skills as its system prompt and the gateway as its only MCP server
 *   (no built-in tools), with NS_AGENT_WRITES=off so no write can be approved or run. Tool calls are read
 *   from the stream-json transcript.
 * - judge(): a second `claude -p` call grades the transcript against the case rubric and returns JSON.
 * - route(): one `claude -p` call classifies a batch of prompts to skill names.
 *
 * Needs the `claude` CLI logged in. Costs model usage: roughly $0.10-0.50 per agent case.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LoadedSkill } from "@ns-agent/mcp-gateway";

export interface AgentRun {
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

function claude(args: string[], timeoutMs = TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
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
      "This is an automated evaluation: no user is available to answer questions. Where you would normally ask",
      "the user to confirm something, state the assumption you are making and continue as far as the skill allows.",
      "Never claim an approval was given unless a tool result says so.",
      "",
      ...enabled.map((s) => `<skill name="${s.manifest.name}">\n${s.manifest.description}\n\n${s.body.trim()}\n</skill>`),
    ].join("\n");
  }

  async run(prompt: string): Promise<AgentRun> {
    const dir = await mkdtemp(path.join(tmpdir(), "ns-agent-eval-"));
    try {
      const mcp = path.join(dir, "mcp.json");
      await writeFile(
        mcp,
        JSON.stringify({
          mcpServers: {
            [SERVER]: {
              command: "sh",
              args: [path.join(this.repoRoot, "scripts/mcp-gateway.sh")],
              env: { NS_AGENT_WRITES: "off" },
            },
          },
        }),
      );
      const out = await claude([
        "-p", prompt,
        "--output-format", "stream-json", "--verbose",
        "--mcp-config", mcp, "--strict-mcp-config",
        "--allowedTools", `mcp__${SERVER}`,
        "--system-prompt", this.systemPrompt(),
        ...BASE_FLAGS,
      ]);
      const calls: AgentRun["calls"] = [];
      let answer = "";
      let costUsd = 0;
      for (const line of out.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        const m = JSON.parse(line) as {
          type: string;
          message?: { content?: Array<{ type: string; name?: string; input?: unknown }> };
          result?: string;
          total_cost_usd?: number;
        };
        if (m.type === "assistant") {
          for (const b of m.message?.content ?? []) {
            if (b.type === "tool_use" && b.name?.startsWith(`mcp__${SERVER}__`)) {
              calls.push({ tool: b.name.slice(`mcp__${SERVER}__`.length), input: b.input });
            }
          }
        } else if (m.type === "result") {
          answer = m.result ?? "";
          costUsd = m.total_cost_usd ?? 0;
        }
      }
      return { toolsCalled: calls.map((c) => c.tool), calls, answer, costUsd };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async judge(prompt: string, rubric: string, run: AgentRun): Promise<Verdict> {
    const transcript = run.calls.map((c, i) => `${i + 1}. ${c.tool} ${JSON.stringify(c.input).slice(0, 800)}`).join("\n") || "(no tool calls)";
    const out = await claude([
      "-p",
      [
        "Grade an AI agent's run against a rubric. The agent works in NetSuite through gateway tools.",
        "The run was automated: no user could answer, so stating an assumption instead of asking is acceptable.",
        'Reply with only JSON: {"pass": true|false, "reason": "<one sentence>"}.',
        "",
        `User prompt: ${prompt}`,
        `Rubric: ${rubric}`,
        `Tool calls:\n${transcript}`,
        `Final answer:\n${run.answer.slice(0, 6000)}`,
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
