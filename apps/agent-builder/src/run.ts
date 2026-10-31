import Anthropic from "@anthropic-ai/sdk";
import { sharedResources, type BuiltAgent } from "./create";

/** Hard spend cap per run, in US cents (fixed rule 6). The session pauses when it is reached. */
export const RUN_BUDGET_CENTS = "500";

export const consoleSessionUrl = (sessionId: string) => `https://platform.claude.com/workspaces/default/sessions/${sessionId}`;

/** Starts one run of a built agent with the shared environment, the NetSuite vault and a spend cap. */
export async function startRun(agent: BuiltAgent, message: string, client = new Anthropic()) {
  const { environmentId, vaultId } = await sharedResources();
  const session = await client.beta.sessions.create({
    agent: { type: "agent", id: agent.agentId, version: agent.version },
    environment_id: environmentId,
    vault_ids: [vaultId],
    title: `${agent.name} (builder run)`,
    budget: { type: "limit", max_list_cost: { amount: RUN_BUDGET_CENTS, currency: "USD" } },
    initial_events: [{ type: "user.message", content: [{ type: "text", text: message }] }],
  });
  return { sessionId: session.id, consoleUrl: consoleSessionUrl(session.id) };
}
