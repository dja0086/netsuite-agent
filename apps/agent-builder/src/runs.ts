import Anthropic from "@anthropic-ai/sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.resolve(here, "../data/runs.json");
const MA_BETA = "managed-agents-2026-04-01" as const;

export interface RunRecord {
  sessionId: string;
  agentId: string;
  agentName: string;
  startedAt: string;
  /** Set when a schedule started the run. */
  deploymentId?: string;
}

export async function listRuns(): Promise<RunRecord[]> {
  try {
    return JSON.parse(await readFile(RUNS, "utf8")) as RunRecord[];
  } catch {
    return [];
  }
}

export async function recordRun(run: RunRecord): Promise<void> {
  await mkdir(path.dirname(RUNS), { recursive: true });
  await writeFile(RUNS, JSON.stringify([...(await listRuns()), run], null, 2));
}

/** Only sessions this builder started can be viewed, approved or downloaded from. */
async function knownRun(sessionId: string): Promise<RunRecord> {
  const run = (await listRuns()).find((r) => r.sessionId === sessionId);
  if (!run) throw new Error("Unknown run: only runs started from this builder can be opened here.");
  return run;
}

// ---- Turning session events into a view (pure, tested) ----

type Event = Record<string, unknown> & { id: string; type: string; processed_at?: string | null };

export type RunItem =
  | { kind: "user"; id: string; at?: string; text: string }
  | { kind: "agent"; id: string; at?: string; text: string }
  | { kind: "tool"; id: string; at?: string; name: string; source: "netsuite" | "sandbox"; permission?: string; input: unknown; result?: string; isError?: boolean }
  | { kind: "decision"; id: string; at?: string; toolUseId: string; result: "allow" | "deny"; denyMessage?: string }
  | { kind: "error"; id: string; at?: string; text: string };

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
        .join("")
    : "";

/** Chronological items for the run log; a tool call carries its result once it arrives. */
export function runItems(events: Event[]): RunItem[] {
  const items: RunItem[] = [];
  const tools = new Map<string, Extract<RunItem, { kind: "tool" }>>();
  for (const e of events) {
    const at = e.processed_at ?? undefined;
    switch (e.type) {
      case "user.message":
        items.push({ kind: "user", id: e.id, at, text: textOf(e.content) });
        break;
      case "agent.message":
        items.push({ kind: "agent", id: e.id, at, text: textOf(e.content) });
        break;
      case "agent.mcp_tool_use":
      case "agent.tool_use": {
        const item = {
          kind: "tool" as const,
          id: e.id,
          at,
          name: String(e.name),
          source: e.type === "agent.mcp_tool_use" ? ("netsuite" as const) : ("sandbox" as const),
          permission: typeof e.evaluated_permission === "string" ? e.evaluated_permission : undefined,
          input: e.input,
        };
        tools.set(e.id, item);
        items.push(item);
        break;
      }
      case "agent.mcp_tool_result":
      case "agent.tool_result": {
        const tool = tools.get(String(e.type === "agent.mcp_tool_result" ? e.mcp_tool_use_id : e.tool_use_id));
        if (tool) {
          tool.result = textOf(e.content).slice(0, 4000);
          tool.isError = e.is_error === true;
        }
        break;
      }
      case "user.tool_confirmation":
        items.push({
          kind: "decision",
          id: e.id,
          at,
          toolUseId: String(e.tool_use_id),
          result: e.result === "allow" ? "allow" : "deny",
          ...(typeof e.deny_message === "string" ? { denyMessage: e.deny_message } : {}),
        });
        break;
      case "session.error": {
        const err = (e.error ?? {}) as { type?: string; message?: string };
        items.push({ kind: "error", id: e.id, at, text: [err.type, err.message].filter(Boolean).join(": ") || "session error" });
        break;
      }
    }
  }
  return items;
}

/**
 * Tool calls waiting for a decision: the event ids named by the latest idle event when it stopped for
 * `requires_action`, minus any already answered, and none once the session is running again.
 */
export function pendingApprovals(events: Event[]): string[] {
  let pending: string[] = [];
  for (const e of events) {
    if (e.type === "session.status_idle") {
      const stop = e.stop_reason as { type?: string; event_ids?: unknown } | undefined;
      pending = stop?.type === "requires_action" && Array.isArray(stop.event_ids) ? stop.event_ids.map(String) : [];
    } else if (e.type === "session.status_running" || e.type === "session.status_terminated") {
      pending = [];
    } else if (e.type === "user.tool_confirmation") {
      pending = pending.filter((id) => id !== e.tool_use_id);
    }
  }
  return pending;
}

/** Why the session last stopped, in the owner's words. */
export function stopNote(events: Event[]): string | undefined {
  const idle = [...events].reverse().find((e) => e.type === "session.status_idle");
  const type = (idle?.stop_reason as { type?: string } | undefined)?.type;
  const notes: Record<string, string> = {
    end_turn: "Finished.",
    requires_action: "Waiting for your approval.",
    budget_reached: "Stopped at its spend cap.",
    retries_exhausted: "Stopped after repeated errors.",
    refusal: "The model declined to continue.",
  };
  return type ? (notes[type] ?? type) : undefined;
}

// ---- Calls to the Managed Agents API ----

async function allEvents(client: Anthropic, sessionId: string): Promise<Event[]> {
  const events: Event[] = [];
  for await (const e of client.beta.sessions.events.list(sessionId, { order: "asc" })) events.push(e as unknown as Event);
  return events;
}

export async function runView(sessionId: string, client = new Anthropic()) {
  const run = await knownRun(sessionId);
  const [session, events, files] = await Promise.all([
    client.beta.sessions.retrieve(sessionId),
    allEvents(client, sessionId),
    runFiles(sessionId, client),
  ]);
  const pending = session.status === "idle" ? pendingApprovals(events) : [];
  return { run, status: session.status, stopNote: session.status === "idle" ? stopNote(events) : undefined, items: runItems(events), pending, files };
}

/** Answers one paused tool call. Refuses ids that are not pending right now. */
export async function decide(sessionId: string, eventId: string, result: "allow" | "deny", denyMessage?: string, client = new Anthropic()) {
  await knownRun(sessionId);
  const session = await client.beta.sessions.retrieve(sessionId);
  const pending = session.status === "idle" ? pendingApprovals(await allEvents(client, sessionId)) : [];
  if (!pending.includes(eventId)) throw new Error("That tool call is not waiting for a decision (already answered, or the run moved on).");
  await client.beta.sessions.events.send(sessionId, {
    events: [
      result === "deny"
        ? { type: "user.tool_confirmation", tool_use_id: eventId, result, ...(denyMessage ? { deny_message: denyMessage } : {}) }
        : { type: "user.tool_confirmation", tool_use_id: eventId, result },
    ],
  });
  return { ok: true };
}

/** Sends a follow-up message to a run that is not waiting on an approval. */
export async function followUp(sessionId: string, text: string, client = new Anthropic()) {
  await knownRun(sessionId);
  const session = await client.beta.sessions.retrieve(sessionId);
  if (session.status === "idle" && pendingApprovals(await allEvents(client, sessionId)).length) {
    throw new Error("Answer the pending approval first.");
  }
  if (session.status === "terminated") throw new Error("This run has ended.");
  await client.beta.sessions.events.send(sessionId, { events: [{ type: "user.message", content: [{ type: "text", text }] }] });
  return { ok: true };
}

export interface RunFile {
  id: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
}

export async function runFiles(sessionId: string, client = new Anthropic()): Promise<RunFile[]> {
  const files: RunFile[] = [];
  for await (const f of client.beta.files.list({ scope_id: sessionId, betas: [MA_BETA] })) {
    if (f.downloadable) files.push({ id: f.id, filename: f.filename, sizeBytes: f.size_bytes, mimeType: f.mime_type });
  }
  return files;
}

/** Downloads a file only if it belongs to a run this builder started. */
export async function downloadFile(sessionId: string, fileId: string, client = new Anthropic()) {
  await knownRun(sessionId);
  const file = (await runFiles(sessionId, client)).find((f) => f.id === fileId);
  if (!file) throw new Error("That file does not belong to this run.");
  const response = await client.beta.files.download(fileId);
  return { file, bytes: Buffer.from(await response.arrayBuffer()) };
}
