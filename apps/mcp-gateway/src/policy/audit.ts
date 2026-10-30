import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";

/** tool.call: a tool ran (or failed). approval.*: the life of a change request (ADR 0004). */
export type AuditEvent = "tool.call" | "approval.requested" | "approval.decided" | "approval.rejected";

export interface AuditEntry {
  ts: string;
  event: AuditEvent;
  tool: string;
  writes: boolean;
  /** Set for tools that write files on the gateway host (never NetSuite). */
  localWrites?: boolean;
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
  /** Files a localWrites tool wrote (paths relative to its folder), never their contents. */
  files?: string[];
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

/** Audit logs are kept this long (owner decision 2026-10-30); `pnpm audit:prune` deletes older monthly files. */
export const AUDIT_RETENTION_DAYS = 365;

/** The monthly file an entry goes to: audit/gateway.jsonl -> audit/gateway-2026-10.jsonl (UTC month of `ts`). */
export function monthlyAuditFile(file: string, ts: string): string {
  return path.join(path.dirname(file), `${path.basename(file, ".jsonl")}-${ts.slice(0, 7)}.jsonl`);
}

/** Appends one JSON line per entry to that entry's monthly file, so retention is a file delete. */
export class JsonlAuditSink implements AuditSink {
  private ready: Promise<void> | undefined;

  constructor(private readonly file: string) {}

  async write(entry: AuditEntry): Promise<void> {
    this.ready ??= mkdir(path.dirname(this.file), { recursive: true }).then(() => undefined);
    await this.ready;
    await appendFile(monthlyAuditFile(this.file, entry.ts), JSON.stringify(entry) + "\n", "utf8");
  }
}

/** The monthly files for `file` with their month (YYYY-MM), oldest first. */
async function monthlyFiles(file: string): Promise<{ path: string; month: string }[]> {
  const dir = path.dirname(file);
  const pattern = new RegExp(`^${path.basename(file, ".jsonl").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d{4}-\\d{2})\\.jsonl$`);
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((f): f is { name: string; match: RegExpExecArray } => f.match !== null)
    .map((f) => ({ path: path.join(dir, f.name), month: f.match[1]! }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/** Entries at or after `since`, from the monthly files that can hold them. Lines that fail to parse are skipped. */
export async function readAuditEntries(file: string, since: Date): Promise<AuditEntry[]> {
  const fromMonth = since.toISOString().slice(0, 7);
  const entries: AuditEntry[] = [];
  for (const f of await monthlyFiles(file)) {
    if (f.month < fromMonth) continue;
    for (const line of (await readFile(f.path, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as AuditEntry;
        // Entries written before the event field existed were all tool calls.
        if (Date.parse(entry.ts) >= since.getTime()) entries.push({ ...entry, event: entry.event ?? "tool.call" });
      } catch {
        // A torn last line from a crash is not worth failing the whole read.
      }
    }
  }
  return entries;
}

/** Deletes monthly files whose whole month ended more than `keepDays` before `now`. Returns the deleted paths. */
export async function pruneAuditFiles(file: string, now: Date, keepDays = AUDIT_RETENTION_DAYS): Promise<string[]> {
  const cutoff = now.getTime() - keepDays * 86_400_000;
  const deleted: string[] = [];
  for (const f of await monthlyFiles(file)) {
    const [year, month] = f.month.split("-").map(Number) as [number, number];
    if (Date.UTC(year, month, 1) <= cutoff) {
      await unlink(f.path);
      deleted.push(f.path);
    }
  }
  return deleted;
}

/** Keeps entries in memory; used by tests and the eval runner. */
export class MemoryAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];
  async write(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

/** NS_AGENT_AUDIT_PATH, else ./audit/gateway.jsonl. Entries land in monthly files next to it. */
export function auditPathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.NS_AGENT_AUDIT_PATH?.trim() || path.resolve("audit", "gateway.jsonl");
}

export function auditSinkFromEnv(env: NodeJS.ProcessEnv = process.env): AuditSink {
  return new JsonlAuditSink(auditPathFromEnv(env));
}
