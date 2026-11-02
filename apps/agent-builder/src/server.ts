#!/usr/bin/env -S npx tsx
/**
 * Agent builder, local only (owner decision D1). Serves one page and a small JSON API on 127.0.0.1.
 * Every API call must carry the token generated at start, and come from this page's own origin,
 * so other websites open in the browser cannot create agents or start runs.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { NETSUITE_TOOLS } from "./catalog";
import { TIERS } from "./tiers";
import { createAgent, listBuilt, updateAgent } from "./create";
import { draftSpec } from "./draft";
import { buildAgentConfig, checkSpec } from "./rules";
import { RUN_BUDGET_CENTS, startRun } from "./run";
import { waitingRuns } from "./pending";
import { decide, downloadFile, followUp, listRuns, runView } from "./runs";
import { createSchedule, listSchedules, repinSchedules, scheduleAction } from "./schedules";
import { AgentSpec } from "./spec";
import { act, changePolicy, evidencePacket, getMeta, getPolicy, listPacks, packView, prepare, redraft, refreshMeta, setDefaultPolicy } from "./flux/service";

const PORT = Number(process.env.BUILDER_PORT ?? 5178);
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const TOKEN = randomBytes(24).toString("base64url");
const here = path.dirname(fileURLToPath(import.meta.url));

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) throw new Error("request too large");
  }
  return raw ? JSON.parse(raw) : {};
}

const SESSION = z.string().regex(/^sesn_[A-Za-z0-9]+$/);
const Decision = z.object({ eventId: z.string().regex(/^sevt_[A-Za-z0-9]+$/), result: z.enum(["allow", "deny"]), denyMessage: z.string().max(500).optional() });

/** Routes with a session id in the path: /api/runs/<sesn_...>[/decide|/message|/files/<file_...>]. */
async function runRoute(method: string, parts: string[], req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (parts[0] !== "api" || parts[1] !== "runs" || !parts[2]) return false;
  const sessionId = SESSION.parse(parts[2]);
  const action = parts.slice(3).join("/");
  if (method === "GET" && action === "") send(res, 200, await runView(sessionId));
  else if (method === "POST" && action === "decide") {
    const d = Decision.parse(await readJson(req));
    send(res, 200, await decide(sessionId, d.eventId, d.result, d.denyMessage));
  } else if (method === "POST" && action === "message") {
    const { text } = z.object({ text: z.string().min(1).max(4000) }).parse(await readJson(req));
    send(res, 200, await followUp(sessionId, text));
  } else if (method === "GET" && parts[3] === "files" && parts[4] && parts.length === 5) {
    const { file, bytes } = await downloadFile(sessionId, z.string().regex(/^file_[A-Za-z0-9]+$/).parse(parts[4]));
    res
      .writeHead(200, {
        "Content-Type": file.mimeType,
        "Content-Disposition": `attachment; filename="${file.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "Cache-Control": "no-store",
      })
      .end(bytes);
  } else send(res, 404, { error: "not found" });
  return true;
}

const Who = z.string().trim().min(1).max(80);
const AccountId = z.number().int().positive();
const FluxAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("edit"), accountId: AccountId, who: Who, text: z.string().trim().min(1).max(4000) }),
  z.object({ type: z.literal("prepare"), accountId: AccountId, who: Who, note: z.string().max(1000).optional() }),
  z.object({ type: z.literal("approve"), accountId: AccountId, who: Who, note: z.string().max(1000).optional() }),
  z.object({ type: z.literal("send_back"), accountId: AccountId, who: Who, note: z.string().trim().min(1).max(1000) }),
  z.object({ type: z.literal("reopen"), accountId: AccountId, who: Who, note: z.string().trim().min(1).max(1000) }),
]);

/** Routes with a pack id in the path: /api/flux/packs/<id>[/action|/redraft|/policy|/export]. */
async function fluxRoute(method: string, parts: string[], req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (parts[0] !== "api" || parts[1] !== "flux" || parts[2] !== "packs" || !parts[3]) return false;
  const id = parts[3];
  const action = parts[4] ?? "";
  if (method === "GET" && action === "") send(res, 200, await packView(id));
  else if (method === "POST" && action === "action") send(res, 200, await act(id, FluxAction.parse(await readJson(req))));
  else if (method === "POST" && action === "redraft") {
    const d = z.object({ accountId: AccountId, who: Who, guidance: z.string().trim().min(1).max(2000) }).parse(await readJson(req));
    send(res, 200, await redraft(id, d.accountId, d.who, d.guidance));
  } else if (method === "POST" && action === "policy") {
    const d = z
      .object({ who: Who, reason: z.string().max(500), amount: z.number().nonnegative().optional(), percent: z.number().nonnegative().optional(), alwaysAmount: z.number().nonnegative().optional(), mode: z.enum(["either", "both"]).optional(), accountId: AccountId.optional(), clearOverride: z.boolean().optional() })
      .parse(await readJson(req));
    const { who, reason, ...change } = d;
    send(res, 200, await changePolicy(id, who, change, reason));
  } else if (method === "GET" && action === "export") {
    const { filename, csv } = await evidencePacket(id);
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" }).end(csv);
  } else send(res, 404, { error: "not found" });
  return true;
}

const routes: Record<string, (body: unknown) => Promise<unknown>> = {
  "GET /api/flux": async () => ({ meta: await getMeta(), policy: await getPolicy(), packs: await listPacks() }),
  "POST /api/flux/periods": async () => refreshMeta(),
  "POST /api/flux/policy": async (body) => setDefaultPolicy(z.object({ amount: z.number().nonnegative(), percent: z.number().nonnegative(), alwaysAmount: z.number().nonnegative(), mode: z.enum(["either", "both"]) }).parse(body)),
  "POST /api/flux/prepare": async (body) => {
    const d = z.object({ cur: AccountId, prior: AccountId, who: Who }).parse(body);
    return { id: await prepare(d.cur, d.prior, d.who) };
  },
  "POST /api/draft": async (body) => {
    const { useCase } = z.object({ useCase: z.string().min(10).max(4000) }).parse(body);
    return draftSpec(useCase);
  },
  "POST /api/check": async (body) => {
    const spec = AgentSpec.parse(body);
    const problems = checkSpec(spec);
    return { problems, config: problems.length ? null : buildAgentConfig(spec) };
  },
  "POST /api/create": async (body) => createAgent(AgentSpec.parse(body)),
  "POST /api/run": async (body) => {
    const { agentId, message } = z.object({ agentId: z.string().startsWith("agent_"), message: z.string().min(1).max(4000) }).parse(body);
    const agent = (await listBuilt()).find((a) => a.agentId === agentId);
    if (!agent) throw new Error("Unknown agent: only agents made by this builder can be run here.");
    return startRun(agent, message);
  },
  "GET /api/agents": async () => listBuilt(),
  "POST /api/agent/update": async (body) => {
    const { agentId, spec } = z.object({ agentId: z.string().startsWith("agent_"), spec: AgentSpec }).parse(body);
    const updated = await updateAgent(agentId, spec);
    return { ...updated, schedulesRepinned: await repinSchedules(updated) };
  },
  "GET /api/schedules": async () => listSchedules(),
  "POST /api/schedules": async (body) => {
    const { agentId, ...input } = z
      .object({ agentId: z.string().startsWith("agent_"), cron: z.string().min(9).max(100), timezone: z.string().min(1).max(64), message: z.string().min(1).max(4000) })
      .parse(body);
    return createSchedule(agentId, input);
  },
  "POST /api/schedule/action": async (body) => {
    const { deploymentId, action } = z.object({ deploymentId: z.string().regex(/^depl_[A-Za-z0-9]+$/), action: z.enum(["pause", "resume", "run", "stop"]) }).parse(body);
    return scheduleAction(deploymentId, action);
  },
  "GET /api/pending": async () => waitingRuns(),
  "GET /api/runs": async () => (await listRuns()).slice().reverse(),
  "GET /api/catalog": async () => ({ tools: NETSUITE_TOOLS, runBudgetCents: RUN_BUDGET_CENTS, tiers: TIERS.map(({ id, label, description, roleName, writeTools, vault }) => ({ id, label, description, roleName, writeTools, signedIn: Boolean(vault) })) }),
};

createServer(async (req, res) => {
  try {
    const route = `${req.method} ${(req.url ?? "/").split("?")[0]}`;
    if (route === "GET /") {
      const html = await readFile(path.resolve(here, "../public/index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(html.replace("__BUILDER_TOKEN__", TOKEN));
      return;
    }
    if (route === "GET /flux.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" }).end(await readFile(path.resolve(here, "../public/flux.js"), "utf8"));
      return;
    }
    const origin = req.headers.origin;
    if ((origin && !ORIGINS.has(origin)) || req.headers["x-builder-token"] !== TOKEN) return send(res, 403, { error: "forbidden" });
    const parts = (req.url ?? "/").split("?")[0]!.split("/").filter(Boolean);
    if (await runRoute(req.method ?? "GET", parts, req, res)) return;
    if (await fluxRoute(req.method ?? "GET", parts, req, res)) return;
    const handler = routes[route];
    if (!handler) return send(res, 404, { error: "not found" });
    send(res, 200, await handler(req.method === "POST" ? await readJson(req) : undefined));
  } catch (error) {
    const message = error instanceof z.ZodError ? `Invalid input: ${error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` : String(error instanceof Error ? error.message : error);
    send(res, 400, { error: message });
  }
}).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`Agent builder: http://127.0.0.1:${PORT}\n`);
});
