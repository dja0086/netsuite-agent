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
    const handler = routes[route];
    if (!handler) return send(res, 404, { error: "not found" });
    const origin = req.headers.origin;
    if ((origin && !ORIGINS.has(origin)) || req.headers["x-builder-token"] !== TOKEN) return send(res, 403, { error: "forbidden" });
    send(res, 200, await handler(req.method === "POST" ? await readJson(req) : undefined));
  } catch (error) {
    const message = error instanceof z.ZodError ? `Invalid input: ${error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` : String(error instanceof Error ? error.message : error);
    send(res, 400, { error: message });
  }
}).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`Agent builder: http://127.0.0.1:${PORT}\n`);
});
