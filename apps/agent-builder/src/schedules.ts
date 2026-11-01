import Anthropic from "@anthropic-ai/sdk";
import type { DeploymentCreateParams } from "@anthropic-ai/sdk/resources/beta/deployments";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { builtAgent, sharedResources, type BuiltAgent, type Shared } from "./create";
import { RUN_BUDGET_CENTS } from "./run";
import { listRuns, recordRun } from "./runs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEDULES = path.resolve(here, "../data/schedules.json");

export interface ScheduleRecord {
  deploymentId: string;
  agentId: string;
  createdAt: string;
}

export interface ScheduleInput {
  cron: string;
  timezone: string;
  message: string;
}

/** Five-field POSIX cron (minute hour day-of-month month day-of-week); minute granularity is the finest. */
const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;

export function checkSchedule(input: ScheduleInput): string[] {
  const problems: string[] = [];
  const fields = input.cron.trim().split(/\s+/);
  if (fields.length !== 5 || !fields.every((f) => CRON_FIELD.test(f))) {
    problems.push("Cron must have five fields: minute hour day-of-month month day-of-week, e.g. 0 8 * * 1 for Mondays at 08:00.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
  } catch {
    problems.push(`"${input.timezone}" is not a time zone name such as America/Los_Angeles.`);
  }
  if (!input.message.trim()) problems.push("The run message is empty.");
  return problems;
}

/** The deployment body: the agent's current version, the shared environment, its tier's vault, the run cap and the kickoff. */
export function buildDeployment(agent: BuiltAgent, input: ScheduleInput, shared: Shared): DeploymentCreateParams {
  const problems = checkSchedule(input);
  if (problems.length) throw new Error(problems.join(" "));
  return {
    name: `${agent.name} (scheduled)`,
    agent: { type: "agent", id: agent.agentId, version: agent.version },
    environment_id: shared.environmentId,
    vault_ids: [shared.vaultId],
    budget: { type: "limit", max_list_cost: { amount: RUN_BUDGET_CENTS, currency: "USD" } },
    initial_events: [{ type: "user.message", content: [{ type: "text", text: input.message.trim() }] }],
    schedule: { type: "cron", expression: input.cron.trim().split(/\s+/).join(" "), timezone: input.timezone },
    metadata: { built_by: "ns-agent-builder" },
  };
}

export async function listScheduleRecords(): Promise<ScheduleRecord[]> {
  try {
    return JSON.parse(await readFile(SCHEDULES, "utf8")) as ScheduleRecord[];
  } catch {
    return [];
  }
}

async function knownSchedule(deploymentId: string): Promise<ScheduleRecord> {
  const record = (await listScheduleRecords()).find((s) => s.deploymentId === deploymentId);
  if (!record) throw new Error("Unknown schedule: only schedules made by this builder can be changed here.");
  return record;
}

export async function createSchedule(agentId: string, input: ScheduleInput, client = new Anthropic()) {
  const agent = await builtAgent(agentId);
  const deployment = await client.beta.deployments.create(buildDeployment(agent, input, await sharedResources(agent.spec.tier)));
  const record: ScheduleRecord = { deploymentId: deployment.id, agentId, createdAt: new Date().toISOString() };
  await mkdir(path.dirname(SCHEDULES), { recursive: true });
  await writeFile(SCHEDULES, JSON.stringify([...(await listScheduleRecords()), record], null, 2));
  return { deploymentId: deployment.id, upcoming: deployment.schedule?.upcoming_runs_at ?? [] };
}

/** Adds sessions that schedules started to the builder's run list, so they open in the run view. */
export async function syncScheduledRuns(client = new Anthropic()): Promise<void> {
  const known = new Set((await listRuns()).map((r) => r.sessionId));
  for (const record of await listScheduleRecords()) {
    const agent = await builtAgent(record.agentId).catch(() => undefined);
    for await (const run of client.beta.deploymentRuns.list({ deployment_id: record.deploymentId })) {
      if (run.session_id && !known.has(run.session_id)) {
        await recordRun({ sessionId: run.session_id, agentId: record.agentId, agentName: agent?.name ?? record.agentId, startedAt: run.created_at, deploymentId: record.deploymentId });
        known.add(run.session_id);
      }
    }
  }
}

export async function listSchedules(client = new Anthropic()) {
  await syncScheduledRuns(client);
  const out = [];
  for (const record of await listScheduleRecords()) {
    const d = await client.beta.deployments.retrieve(record.deploymentId);
    if (d.archived_at) continue;
    const runs = [];
    for await (const run of client.beta.deploymentRuns.list({ deployment_id: record.deploymentId })) {
      runs.push({ at: run.created_at, trigger: run.trigger_context.type, sessionId: run.session_id, error: run.error ? `${run.error.type}` : null });
      if (runs.length >= 5) break;
    }
    out.push({
      deploymentId: d.id,
      agentId: record.agentId,
      name: d.name,
      status: d.status,
      cron: d.schedule?.expression,
      timezone: d.schedule?.timezone,
      next: d.schedule?.upcoming_runs_at?.[0] ?? null,
      lastRunAt: d.schedule?.last_run_at ?? null,
      agentVersion: d.agent.version,
      runs,
    });
  }
  return out;
}

export async function scheduleAction(deploymentId: string, action: "pause" | "resume" | "run" | "stop", client = new Anthropic()) {
  await knownSchedule(deploymentId);
  if (action === "pause") await client.beta.deployments.pause(deploymentId);
  else if (action === "resume") await client.beta.deployments.unpause(deploymentId);
  else if (action === "stop") await client.beta.deployments.archive(deploymentId);
  else {
    const run = await client.beta.deployments.run(deploymentId);
    await syncScheduledRuns(client);
    return { sessionId: run.session_id, error: run.error?.type ?? null };
  }
  return { ok: true };
}

/** After an agent gets a new version, points its schedules at that version and its tier's vault. */
export async function repinSchedules(agent: BuiltAgent, client = new Anthropic()): Promise<number> {
  let count = 0;
  for (const record of (await listScheduleRecords()).filter((s) => s.agentId === agent.agentId)) {
    const d = await client.beta.deployments.retrieve(record.deploymentId);
    if (d.archived_at) continue;
    await client.beta.deployments.update(record.deploymentId, {
      agent: { type: "agent", id: agent.agentId, version: agent.version },
      name: `${agent.name} (scheduled)`,
      vault_ids: [(await sharedResources(agent.spec.tier)).vaultId],
    });
    count++;
  }
  return count;
}
