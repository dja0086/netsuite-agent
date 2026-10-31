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
import { createAgent, listBuilt } from "./create";
import { draftSpec } from "./draft";
import { buildAgentConfig, checkSpec } from "./rules";
import { RUN_BUDGET_CENTS, startRun } from "./run";
import { decide, downloadFile, followUp, listRuns, runView } from "./runs";
import { AgentSpec } from "./spec";

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

const routes: Record<string, (body: unknown) => Promise<unknown>> = {
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
  "GET /api/runs": async () => (await listRuns()).slice().reverse(),
  "GET /api/catalog": async () => ({ tools: NETSUITE_TOOLS, runBudgetCents: RUN_BUDGET_CENTS }),
};

createServer(async (req, res) => {
  try {
    const route = `${req.method} ${(req.url ?? "/").split("?")[0]}`;
    if (route === "GET /") {
      const html = await readFile(path.resolve(here, "../public/index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(html.replace("__BUILDER_TOKEN__", TOKEN));
      return;
    }
    const origin = req.headers.origin;
    if ((origin && !ORIGINS.has(origin)) || req.headers["x-builder-token"] !== TOKEN) return send(res, 403, { error: "forbidden" });
    const parts = (req.url ?? "/").split("?")[0]!.split("/").filter(Boolean);
    if (await runRoute(req.method ?? "GET", parts, req, res)) return;
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
