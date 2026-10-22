import { userInfo } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MetadataCache, NsHttpError, type NsRequester } from "@ns-agent/ns-client";
import { QueryRejectedError } from "@ns-agent/suiteql";
import { z } from "zod";
import { ApprovalDeniedError, ApprovalInvalidError, ApprovalPendingError, type ApprovalService } from "./policy/approval";
import { hashInput, type AuditEntry, type AuditSink } from "./policy/audit";
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
  /** NetSuite account the gateway talks to. Approvals are bound to it, so one never runs against another account. */
  accountId: string;
  /** Who the agent acts for, recorded on change requests (NS_AGENT_USER, else the OS user). */
  requestedBy?: string;
}

export interface Gateway {
  server: McpServer;
  /** Names of the tools this instance serves. */
  exposed: string[];
}

const SERVER_INSTRUCTIONS =
  "NetSuite gateway. Tools are read-only unless marked otherwise; writes require human approval. " +
  "Prefer ns_suiteql with aggregation over fetching many rows. Call ns_record_describe before guessing field ids. " +
  "A write tool's first call returns approval_pending with a preview and changes nothing: show the preview, wait until " +
  "the user says it was approved, then call the same tool with the same arguments plus approvalId.";

const APPROVAL_ID = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "an approvalId returned by an earlier call")
  .optional()
  .describe("Leave out on the first call. After a human approves the returned request, pass its approvalId to run the write.");

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
  } else if (error instanceof ApprovalPendingError) {
    code = "APPROVAL_PENDING";
    message = error.message;
  } else if (error instanceof ApprovalInvalidError) {
    code = "APPROVAL_INVALID";
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

  for (const tool of tools) {
    if (tool.writes && wanted.has(tool.name) && !tool.describeChange) {
      throw new Error(`Write tool ${tool.name} has no describeChange; approvers must see what it would change (ADR 0004).`);
    }
  }
  const requestedBy = options.requestedBy ?? (process.env.NS_AGENT_USER?.trim() || userInfo().username);

  const server = new McpServer(
    { name: "ns-agent-gateway", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const ctx: ToolContext = {
    ns: options.ns,
    metadata: options.metadata ?? new MetadataCache(options.ns),
    redact: (value) => redact(value, options.redactFields),
  };
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
        inputSchema: tool.writes ? tool.input.extend({ approvalId: APPROVAL_ID }) : tool.input,
        annotations: { readOnlyHint: !tool.writes && !tool.localWrites, destructiveHint: tool.writes, openWorldHint: false },
      },
      (async (input: Record<string, unknown>): Promise<CallToolResult> => {
        const started = Date.now();
        const { approvalId: presented, ...args } = input as { approvalId?: string } & Record<string, unknown>;
        // Writes hash the account too, so an approval is bound to one tool, one payload and one account.
        const inputHash = tool.writes
          ? hashInput({ tool: tool.name, args, accountId: options.accountId })
          : hashInput({ tool: tool.name, args });
        const audit = (entry: Partial<AuditEntry> & Pick<AuditEntry, "event" | "ok">) =>
          options.audit.write({
            ts: new Date(started).toISOString(),
            tool: tool.name,
            writes: tool.writes,
            ms: Date.now() - started,
            inputHash,
            ...entry,
          });
        let approvalId: string | undefined;
        let approvedBy: string | undefined;
        let consumed = false;
        try {
          if (tool.writes) {
            // With writes switched off, refuse before describeChange so a blocked write never touches NetSuite.
            if (!options.approvals.enabled) {
              throw new ApprovalDeniedError(
                `${tool.name} writes to NetSuite and writes are not enabled: no approvers are configured (set NS_AGENT_APPROVERS). No change was made.`,
              );
            }
            if (!presented) {
              const preview = await tool.describeChange!(args, ctx);
              const request = await options.approvals.request({
                tool: tool.name,
                accountId: options.accountId,
                payloadHash: inputHash,
                preview,
                payload: args,
                requestedBy,
                ttlMinutes: tool.approvalTtlMinutes,
              });
              await audit({ event: "approval.requested", ok: true, approvalId: request.approvalId, actor: requestedBy });
              const value = {
                status: "approval_pending",
                approvalId: request.approvalId,
                preview,
                expiresAt: request.expiresAt,
                next:
                  "Nothing was changed. Show the preview to the user. After a named approver approves it " +
                  (request.channelRef
                    ? `(by commenting /approve ${request.payloadHash.slice(0, 12)} on ${request.channelRef})`
                    : `(pnpm approvals approve ${request.approvalId})`) +
                  ", call this tool again with the same arguments and this approvalId.",
                ...(request.channelRef ? { approvalIssue: request.channelRef } : {}),
              };
              return { content: [{ type: "text", text: JSON.stringify(value) }] };
            }
            approvalId = presented;
            const decision = await options.approvals.consume(presented, {
              tool: tool.name,
              accountId: options.accountId,
              payloadHash: inputHash,
            });
            consumed = true;
            approvedBy = decision.approvedBy;
          }
          const value = redact(await tool.handler(args, ctx), options.redactFields);
          if (consumed) await options.approvals.complete(approvalId!, true);
          await audit({ event: "tool.call", ok: true, rowCount: rowCountOf(value), approvalId, approvedBy });
          return { content: [{ type: "text", text: JSON.stringify(value) }] };
        } catch (error) {
          if (consumed) await options.approvals.complete(approvalId!, false);
          const { result, code } = errorResult(error);
          const rejected = tool.writes && presented && !consumed;
          await audit({ event: rejected ? "approval.rejected" : "tool.call", ok: false, errorCode: code, approvalId, approvedBy });
          if (code === "INTERNAL_ERROR") process.stderr.write(`[gateway] ${tool.name} failed: ${String(error)}\n`);
          return result;
        }
      }) as never,
    );
  }

  return { server, exposed };
}
