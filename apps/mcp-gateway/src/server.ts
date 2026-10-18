import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MetadataCache, NsHttpError, type NsRequester } from "@ns-agent/ns-client";
import { QueryRejectedError } from "@ns-agent/suiteql";
import { ApprovalDeniedError, type ApprovalService } from "./policy/approval";
import { hashInput, type AuditSink } from "./policy/audit";
import { redact } from "./policy/redact";
import { ToolInputError, type ToolContext, type ToolDef } from "./registry";
import { declaredTools, type LoadedSkill } from "./skills";
import { ALL_TOOLS } from "./tools";

export interface GatewayOptions {
  ns: NsRequester;
  skills: LoadedSkill[];
  audit: AuditSink;
  approvals: ApprovalService;
  redactFields: ReadonlySet<string>;
  tools?: ToolDef[];
  metadata?: MetadataCache;
}

export interface Gateway {
  server: McpServer;
  /** Names of the tools this instance serves. */
  exposed: string[];
}

const SERVER_INSTRUCTIONS =
  "NetSuite gateway. Tools are read-only unless marked otherwise; writes require human approval. " +
  "Prefer ns_suiteql with aggregation over fetching many rows. Call ns_record_describe before guessing field ids.";

/** Turns any error into a result the model can read without leaking response bodies or stack traces. */
function errorResult(error: unknown): { result: CallToolResult; code: string } {
  let code = "INTERNAL_ERROR";
  let message = "The tool failed unexpectedly. The error was logged.";
  if (error instanceof QueryRejectedError || error instanceof ToolInputError) {
    code = "INVALID_INPUT";
    message = error.message;
  } else if (error instanceof ApprovalDeniedError) {
    code = "APPROVAL_DENIED";
    message = error.message;
  } else if (error instanceof NsHttpError) {
    code = error.code ?? `HTTP_${error.status}`;
    message = `NetSuite rejected the request (${code}): ${error.message}`;
  } else if (error instanceof Error && /^Invalid /.test(error.message)) {
    code = "INVALID_INPUT";
    message = error.message;
  }
  return { result: { isError: true, content: [{ type: "text", text: message }] }, code };
}

function rowCountOf(value: unknown): number | undefined {
  if (value && typeof value === "object" && "rowCount" in value && typeof value.rowCount === "number") return value.rowCount;
  return undefined;
}

export function createGateway(options: GatewayOptions): Gateway {
  const tools = options.tools ?? ALL_TOOLS;
  const wanted = declaredTools(options.skills);
  const unknown = [...wanted].filter((name) => !tools.some((t) => t.name === name));
  if (unknown.length) {
    throw new Error(`Skills declare tools the gateway does not have: ${unknown.join(", ")}`);
  }

  const server = new McpServer(
    { name: "ns-agent-gateway", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const ctx: ToolContext = { ns: options.ns, metadata: options.metadata ?? new MetadataCache(options.ns) };
  const exposed: string[] = [];

  for (const tool of tools) {
    // A tool no enabled skill declares is never served.
    if (!wanted.has(tool.name)) continue;
    exposed.push(tool.name);

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: !tool.writes, destructiveHint: tool.writes, openWorldHint: false },
      },
      (async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const started = Date.now();
        const inputHash = hashInput({ tool: tool.name, args });
        let approvalId: string | undefined;
        try {
          if (tool.writes) {
            const decision = await options.approvals.require({
              tool: tool.name,
              summary: `${tool.title}`,
              payloadHash: inputHash,
            });
            approvalId = decision.approvalId;
          }
          const value = redact(await tool.handler(args, ctx), options.redactFields);
          await options.audit.write({
            ts: new Date(started).toISOString(),
            tool: tool.name,
            writes: tool.writes,
            ok: true,
            ms: Date.now() - started,
            inputHash,
            rowCount: rowCountOf(value),
            approvalId,
          });
          return { content: [{ type: "text", text: JSON.stringify(value) }] };
        } catch (error) {
          const { result, code } = errorResult(error);
          await options.audit.write({
            ts: new Date(started).toISOString(),
            tool: tool.name,
            writes: tool.writes,
            ok: false,
            ms: Date.now() - started,
            inputHash,
            errorCode: code,
            approvalId,
          });
          if (code === "INTERNAL_ERROR") process.stderr.write(`[gateway] ${tool.name} failed: ${String(error)}\n`);
          return result;
        }
      }) as never,
    );
  }

  return { server, exposed };
}
