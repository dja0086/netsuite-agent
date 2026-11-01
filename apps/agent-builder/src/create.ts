import Anthropic from "@anthropic-ai/sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertConfigSafe, buildAgentConfig } from "./rules";
import type { AgentSpec } from "./spec";
import { LEGACY_TIER, vaultFor } from "./tiers";

const here = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = path.resolve(here, "../data/agents.json");
/** Phase 0's environment (limited networking, MCP servers only), shared by every built agent. Vaults come per role tier. */
const PHASE0_LOCK = path.resolve(here, "../../../managed-agents/phase0/claude-lock.json");

export interface BuiltAgent {
  agentId: string;
  version: number;
  name: string;
  createdAt: string;
  updatedAt?: string;
  spec: AgentSpec;
}

export interface Shared {
  environmentId: string;
  vaultId: string;
}

/** The shared environment (Phase 0 lock file) and the vault holding the NetSuite sign-in of an agent's role tier. */
export async function sharedResources(tierId: string): Promise<Shared> {
  const lock = JSON.parse(await readFile(PHASE0_LOCK, "utf8")) as { resources: Record<string, { id: string }> };
  const environmentId = lock.resources["./environment.yaml"]?.id;
  if (!environmentId?.startsWith("env_")) throw new Error(`No environment in ${PHASE0_LOCK}`);
  return { environmentId, vaultId: vaultFor(tierId) };
}

export async function listBuilt(): Promise<BuiltAgent[]> {
  try {
    const agents = JSON.parse(await readFile(REGISTRY, "utf8")) as BuiltAgent[];
    return agents.map((a) => ({ ...a, spec: { ...a.spec, tier: a.spec.tier ?? LEGACY_TIER } }));
  } catch {
    return [];
  }
}

async function saveBuilt(agents: BuiltAgent[]): Promise<void> {
  await mkdir(path.dirname(REGISTRY), { recursive: true });
  await writeFile(REGISTRY, JSON.stringify(agents, null, 2));
}

/** An agent this builder made; nothing else can be run, edited or scheduled from here. */
export async function builtAgent(agentId: string): Promise<BuiltAgent> {
  const agent = (await listBuilt()).find((a) => a.agentId === agentId);
  if (!agent) throw new Error("Unknown agent: only agents made by this builder can be used here.");
  return agent;
}

/** Creates the Managed Agent for a spec (rules applied and re-checked) and records it locally. */
export async function createAgent(spec: AgentSpec, client = new Anthropic()): Promise<BuiltAgent> {
  const config = buildAgentConfig(spec);
  assertConfigSafe(config);
  const agent = await client.beta.agents.create(config);
  const built: BuiltAgent = { agentId: agent.id, version: agent.version, name: agent.name, createdAt: new Date().toISOString(), spec };
  await saveBuilt([...(await listBuilt()), built]);
  return built;
}

/**
 * Saves an edited spec as a new version of an existing agent (rules applied and re-checked).
 * Fields are sent in full, so a removed skill or tool is removed, not preserved.
 */
export async function updateAgent(agentId: string, spec: AgentSpec, client = new Anthropic()): Promise<BuiltAgent> {
  const current = await builtAgent(agentId);
  const config = buildAgentConfig(spec);
  assertConfigSafe(config);
  const agent = await client.beta.agents.update(agentId, { ...config, skills: config.skills ?? [], version: current.version });
  const updated: BuiltAgent = { ...current, version: agent.version, name: agent.name, updatedAt: new Date().toISOString(), spec };
  await saveBuilt((await listBuilt()).map((a) => (a.agentId === agentId ? updated : a)));
  return updated;
}
