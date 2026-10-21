import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ApprovalStore, ChangeRequest, ChangeStatus } from "./approval";

/** Keeps change requests in memory; used by tests. JavaScript runs each transition without interleaving. */
export class MemoryApprovalStore implements ApprovalStore {
  private readonly requests = new Map<string, ChangeRequest>();

  async create(request: ChangeRequest): Promise<void> {
    if (this.requests.has(request.approvalId)) throw new Error(`duplicate approval ${request.approvalId}`);
    this.requests.set(request.approvalId, { ...request });
  }

  async get(approvalId: string): Promise<ChangeRequest | undefined> {
    const r = this.requests.get(approvalId);
    return r && { ...r };
  }

  async list(status?: ChangeStatus): Promise<ChangeRequest[]> {
    return [...this.requests.values()].filter((r) => !status || r.status === status).map((r) => ({ ...r }));
  }

  async transition(approvalId: string, from: ChangeStatus, to: ChangeStatus, patch: Partial<ChangeRequest> = {}): Promise<boolean> {
    const r = this.requests.get(approvalId);
    if (!r || r.status !== from) return false;
    this.requests.set(approvalId, { ...r, ...patch, approvalId, status: to });
    return true;
  }
}

/**
 * Change requests in a local SQLite file, shared by the gateway and the approvals CLI on one machine.
 * Status changes are a single conditional UPDATE, so two processes can never both consume one approval.
 */
export class SqliteApprovalStore implements ApprovalStore {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `);
  }

  private static row(r: unknown): ChangeRequest {
    const { status, data } = r as { status: ChangeStatus; data: string };
    return { ...(JSON.parse(data) as ChangeRequest), status };
  }

  async create(request: ChangeRequest): Promise<void> {
    const { status, ...data } = request;
    this.db
      .prepare("INSERT INTO approvals (id, status, created_at, data) VALUES (?, ?, ?, ?)")
      .run(request.approvalId, status, request.createdAt, JSON.stringify(data));
  }

  async get(approvalId: string): Promise<ChangeRequest | undefined> {
    const r = this.db.prepare("SELECT status, data FROM approvals WHERE id = ?").get(approvalId);
    return r ? SqliteApprovalStore.row(r) : undefined;
  }

  async list(status?: ChangeStatus): Promise<ChangeRequest[]> {
    const rows = status
      ? this.db.prepare("SELECT status, data FROM approvals WHERE status = ? ORDER BY created_at").all(status)
      : this.db.prepare("SELECT status, data FROM approvals ORDER BY created_at").all();
    return rows.map((r) => SqliteApprovalStore.row(r));
  }

  async transition(approvalId: string, from: ChangeStatus, to: ChangeStatus, patch: Partial<ChangeRequest> = {}): Promise<boolean> {
    const { status: _ignored, approvalId: _id, ...fields } = patch;
    const result = this.db
      .prepare("UPDATE approvals SET status = ?, data = json_patch(data, ?) WHERE id = ? AND status = ?")
      .run(to, JSON.stringify(fields), approvalId, from);
    return Number(result.changes) === 1;
  }

  close(): void {
    this.db.close();
  }
}
