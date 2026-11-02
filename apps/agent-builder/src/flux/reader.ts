import Anthropic from "@anthropic-ai/sdk";
import { builtAgent, createAgent, listBuilt, type BuiltAgent } from "../create";
import { startRun } from "../run";
import { decide } from "../runs";
import type { AgentSpec } from "../spec";
import { TIERS } from "../tiers";

/**
 * Reads NetSuite for flux through a Managed Agent, the only way this builder reaches the account. The agent runs the
 * exact queries it is given. Rows are taken from the tool results in the session's event log, and only for a call whose
 * query matches ours character for character, so the model never retypes a number and cannot change a query.
 */
const READER_NAME = "Flux data reader";
const READER_MODEL = "claude-haiku-5-5";
const POLL_MS = 3000;
const BATCH_TIMEOUT_MS = 8 * 60_000;

const readerSpec = (tier: string): AgentSpec => ({
  name: READER_NAME,
  description: "Runs the agent builder's fixed flux analysis queries, read-only, for the Flux page.",
  instructions:
    "You run SuiteQL for the agent builder. Each message lists numbered queries. Call nsagent_suiteql once per query, in order, one call at a time, with limit 200 and the query text copied exactly, character for character. Do not change, fix, shorten or combine a query. Do not run anything else. If a query returns an error, move on to the next one. When all are done, reply with the single word done. Do not summarize results.",
  tier,
  readTools: ["nsagent_suiteql"],
  writeTools: [],
  outputFiles: [],
  kickoff: "Run the queries in this message.",
  openQuestions: [],
});

/** Read-only tier when it is signed in; otherwise Clerk, which is safe here because this agent has every write tool disabled. */
const readerTier = () => (TIERS.find((t) => t.id === "read")?.vault ? "read" : "clerk");

export async function ensureReader(): Promise<BuiltAgent> {
  const existing = (await listBuilt()).find((a) => a.name === READER_NAME);
  if (existing) return builtAgent(existing.agentId);
  return createAgent(readerSpec(readerTier()), undefined, { model: READER_MODEL });
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  hasMore: boolean;
}

type Event = Record<string, unknown> & { id: string; type: string };

const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("") : "";

/** Pulls results for the wanted queries out of a session's events. Pure, so it can be tested without a session. */
export function resultsFromEvents(events: Event[], wanted: string[]): { results: Map<string, QueryResult>; errors: Map<string, string> } {
  const uses = new Map<string, string>();
  const results = new Map<string, QueryResult>();
  const errors = new Map<string, string>();
  const want = new Set(wanted);
  for (const e of events) {
    if (e.type === "agent.mcp_tool_use" && e.name === "nsagent_suiteql") {
      const query = (e.input as { query?: unknown } | undefined)?.query;
      if (typeof query === "string" && want.has(query)) uses.set(e.id, query);
    } else if (e.type === "agent.mcp_tool_result") {
      const query = uses.get(String(e.mcp_tool_use_id));
      if (!query) continue;
      let body: { rows?: Record<string, unknown>[]; hasMore?: boolean; error?: string };
      try {
        body = JSON.parse(textOf(e.content));
      } catch {
        errors.set(query, "The tool returned something that is not JSON.");
        continue;
      }
      if (body.error || !Array.isArray(body.rows)) errors.set(query, body.error ?? "The tool returned no rows.");
      else {
        results.set(query, { rows: body.rows, hasMore: body.hasMore === true });
        errors.delete(query);
      }
    }
  }
  return { results, errors };
}

async function allEvents(client: Anthropic, sessionId: string): Promise<Event[]> {
  const events: Event[] = [];
  for await (const e of client.beta.sessions.events.list(sessionId, { order: "asc" })) events.push(e as unknown as Event);
  return events;
}

const message = (queries: string[]) => `Run these ${queries.length} queries.\n\n${queries.map((q, i) => `Query ${i + 1}:\n${q}`).join("\n\n")}`;

export class ReaderSession {
  private constructor(
    readonly sessionId: string,
    private readonly client: Anthropic,
  ) {}

  static async start(queries: string[], client = new Anthropic()): Promise<{ session: ReaderSession; results: Map<string, QueryResult> }> {
    const agent = await ensureReader();
    const { sessionId } = await startRun(agent, message(queries), client);
    const session = new ReaderSession(sessionId, client);
    return { session, results: await session.collect(queries) };
  }

  async run(queries: string[]): Promise<Map<string, QueryResult>> {
    if (!queries.length) return new Map();
    await this.client.beta.sessions.events.send(this.sessionId, { events: [{ type: "user.message", content: [{ type: "text", text: message(queries) }] }] });
    return this.collect(queries);
  }

  /** Waits for every query. A query that fails or is altered gets one more try; then this refuses, rather than showing partial data. */
  private async collect(queries: string[], retried = false): Promise<Map<string, QueryResult>> {
    const deadline = Date.now() + BATCH_TIMEOUT_MS;
    let sawRunning = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const events = await allEvents(this.client, this.sessionId);
      const { results, errors } = resultsFromEvents(events, queries);
      if (results.size === queries.length) return results;
      const session = await this.client.beta.sessions.retrieve(this.sessionId);
      if (session.status === "running") sawRunning = true;
      if (session.status === "terminated") throw new Error("The NetSuite reader session ended before finishing.");
      if (session.status !== "idle") continue;
      const last = [...events].reverse().find((e) => e.type === "session.status_idle");
      const stop = (last?.stop_reason ?? {}) as { type?: string; event_ids?: unknown };
      if (stop.type === "requires_action" && Array.isArray(stop.event_ids)) {
        // Only an unlisted tool can ask here; the reader has no business using one.
        for (const id of stop.event_ids) await decide(this.sessionId, String(id), "deny", "Only nsagent_suiteql with the given queries is allowed.", this.client);
        continue;
      }
      if (!sawRunning && events[events.length - 1]?.type === "user.message") continue;
      if (stop.type === "budget_reached") throw new Error("The NetSuite reader reached its spend cap.");
      if (stop.type !== "end_turn") continue;
      const missing = queries.filter((q) => !results.has(q));
      if (retried) throw new Error(`NetSuite did not return ${missing.length} of ${queries.length} queries.${errors.size ? ` First error: ${[...errors.values()][0]}` : ""}`);
      await this.client.beta.sessions.events.send(this.sessionId, { events: [{ type: "user.message", content: [{ type: "text", text: message(missing) }] }] });
      return new Map([...results, ...(await this.collect(missing, true))]);
    }
    throw new Error("Timed out waiting for the NetSuite reader.");
  }
}
