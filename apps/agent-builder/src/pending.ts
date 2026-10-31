import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { listRuns, pendingApprovals, type RunRecord } from "./runs";
import { syncScheduledRuns } from "./schedules";

const here = path.dirname(fileURLToPath(import.meta.url));
const ALERTED = path.resolve(here, "../data/alerted.json");
/** Runs older than this are not checked again. */
const LOOKBACK_DAYS = 14;

export interface WaitingRun {
  sessionId: string;
  agentName: string;
  scheduled: boolean;
  waiting: number;
  /** Names of the paused tools, for the "Approve …" card title. Never their inputs. */
  tools: string[];
}

/** Runs from this builder (scheduled or not) that are paused on at least one approval right now. */
export async function waitingRuns(client = new Anthropic()): Promise<WaitingRun[]> {
  await syncScheduledRuns(client);
  const since = Date.now() - LOOKBACK_DAYS * 86_400_000;
  const waiting: WaitingRun[] = [];
  for (const run of (await listRuns()).filter((r) => Date.parse(r.startedAt) >= since)) {
    const session = await client.beta.sessions.retrieve(run.sessionId).catch(() => undefined);
    if (session?.status !== "idle") continue;
    const events: Parameters<typeof pendingApprovals>[0] = [];
    for await (const e of client.beta.sessions.events.list(run.sessionId, { order: "asc" })) events.push(e as unknown as (typeof events)[number]);
    const pending = pendingApprovals(events);
    const names = pending.map((id) => String(events.find((e) => e.id === id)?.name ?? "a tool"));
    if (pending.length) waiting.push({ sessionId: run.sessionId, agentName: run.agentName, scheduled: Boolean(run.deploymentId), waiting: pending.length, tools: names });
  }
  return waiting;
}

/**
 * The GitHub issue for one waiting run. The repo is public, so it names the agent and the run only:
 * never the tool, its input or anything read from NetSuite.
 */
export function alertIssue(run: Pick<RunRecord, "agentName" | "sessionId">, waiting: number) {
  return {
    title: `NetSuite agent waiting for approval: ${run.agentName}`,
    body: [
      `The run \`${run.sessionId}\` of **${run.agentName}** is paused until you approve or deny ${waiting === 1 ? "a tool call" : `${waiting} tool calls`}.`,
      "",
      "Open the agent builder (`pnpm builder`), then For you, to see the exact request and decide. Close this issue afterwards.",
    ].join("\n"),
  };
}

async function alerted(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(ALERTED, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Opens one issue per waiting run (never twice for the same run). Returns what it did. */
export async function alertWaiting(repo: string, client = new Anthropic()) {
  const done = await alerted();
  const opened: string[] = [];
  const waiting = await waitingRuns(client);
  for (const run of waiting) {
    if (done[run.sessionId]) continue;
    const { title, body } = alertIssue(run, run.waiting);
    const { stdout } = await promisify(execFile)("gh", ["issue", "create", "--repo", repo, "--title", title, "--body", body]);
    done[run.sessionId] = stdout.trim();
    opened.push(done[run.sessionId]!);
  }
  await mkdir(path.dirname(ALERTED), { recursive: true });
  await writeFile(ALERTED, JSON.stringify(done, null, 2));
  return { waiting: waiting.length, opened };
}
