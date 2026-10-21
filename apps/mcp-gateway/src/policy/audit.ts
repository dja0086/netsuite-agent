import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/** tool.call: a tool ran (or failed). approval.*: the life of a change request (ADR 0004). */
export type AuditEvent = "tool.call" | "approval.requested" | "approval.decided" | "approval.rejected";

export interface AuditEntry {
  ts: string;
  event: AuditEvent;
  tool: string;
  writes: boolean;
  ok: boolean;
  ms: number;
  /** sha256 of the canonical input. Inputs and results are never stored, only their fingerprint. */
  inputHash: string;
  rowCount?: number;
  errorCode?: string;
  approvalId?: string;
  /** The named approver whose decision this entry records or relies on. */
  approvedBy?: string;
  /** Who made an approval decision or requested the change. */
  actor?: string;
}

export interface AuditSink {
  write(entry: AuditEntry): Promise<void>;
}

/** Stable JSON (sorted keys) so the same input always hashes the same. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export function hashInput(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Appends one JSON line per tool call. Ship the file to your log platform for retention ([FILL: retention]). */
export class JsonlAuditSink implements AuditSink {
  private ready: Promise<void> | undefined;

  constructor(private readonly file: string) {}

  async write(entry: AuditEntry): Promise<void> {
    this.ready ??= mkdir(path.dirname(this.file), { recursive: true }).then(() => undefined);
    await this.ready;
    await appendFile(this.file, JSON.stringify(entry) + "\n", "utf8");
  }
}

/** Keeps entries in memory; used by tests and the eval runner. */
export class MemoryAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];
  async write(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

export function auditSinkFromEnv(env: NodeJS.ProcessEnv = process.env): AuditSink {
  return new JsonlAuditSink(env.NS_AGENT_AUDIT_PATH?.trim() || path.resolve("audit", "gateway.jsonl"));
}
