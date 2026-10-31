import Anthropic from "@anthropic-ai/sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertConfigSafe, buildAgentConfig } from "./rules";
import type { AgentSpec } from "./spec";

const here = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = path.resolve(here, "../data/agents.json");
/** Phase 0's environment (limited networking, MCP servers only) and NetSuite vault, shared by every built agent. */
const PHASE0_LOCK = path.resolve(here, "../../../managed-agents/phase0/claude-lock.json");

export interface BuiltAgent {
  agentId: string;
  version: number;
  name: string;
  createdAt: string;
  spec: AgentSpec;
}

export interface Shared {
  environmentId: string;
  vaultId: string;
}

/** The shared environment and vault IDs, from the Phase 0 lock file. */
export async function sharedResources(): Promise<Shared> {
  const lock = JSON.parse(await readFile(PHASE0_LOCK, "utf8")) as { resources: Record<string, { id: string }> };
  const environmentId = lock.resources["./environment.yaml"]?.id;
  const vaultId = lock.resources["./vault.yaml"]?.id;
  if (!environmentId?.startsWith("env_") || !vaultId?.startsWith("vlt_")) throw new Error(`No environment or vault in ${PHASE0_LOCK}`);
  return { environmentId, vaultId };
}

export async function listBuilt(): Promise<BuiltAgent[]> {
  try {
    return JSON.parse(await readFile(REGISTRY, "utf8")) as BuiltAgent[];
  } catch {
    return [];
  }
}

/** Creates the Managed Agent for a spec (rules applied and re-checked) and records it locally. */
export async function createAgent(spec: AgentSpec, client = new Anthropic()): Promise<BuiltAgent> {
  const config = buildAgentConfig(spec);
  assertConfigSafe(config);
  const agent = await client.beta.agents.create(config);
  const built: BuiltAgent = { agentId: agent.id, version: agent.version, name: agent.name, createdAt: new Date().toISOString(), spec };
  await mkdir(path.dirname(REGISTRY), { recursive: true });
  await writeFile(REGISTRY, JSON.stringify([...(await listBuilt()), built], null, 2));
  return built;
}
