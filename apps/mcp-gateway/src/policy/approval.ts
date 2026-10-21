import { randomUUID } from "node:crypto";

/**
 * Approvals for data writes (ADR 0004). A write tool's first call creates a pending change request and runs
 * nothing; a named approver decides it out of band; the agent's second call, carrying `approvalId`, runs the
 * write only if the approval is approved, unexpired, unused and bound to the same tool, account and payload.
 */

export type ChangeStatus = "pending" | "approved" | "denied" | "executing" | "executed" | "failed" | "expired";

export interface ChangeRequest {
  approvalId: string;
  tool: string;
  accountId: string;
  /** sha256 of canonical { tool, args (without approvalId), accountId }. */
  payloadHash: string;
  /** What the approver reads, produced by the tool's describeChange. */
  preview: string;
  /** The tool arguments, kept in the store only so the approver can inspect them. Never audited. */
  payload: unknown;
  requestedBy: string;
  status: ChangeStatus;
  /** Approval window applied when the request is approved. */
  ttlMinutes: number;
  createdAt: string;
  /** Pending requests close at this time; once approved, the approval expires at this time. */
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
}

/** Where change requests live. transition() must be atomic: the single-use rule depends on it. */
export interface ApprovalStore {
  create(request: ChangeRequest): Promise<void>;
  get(approvalId: string): Promise<ChangeRequest | undefined>;
  list(status?: ChangeStatus): Promise<ChangeRequest[]>;
  /** Moves a request from one status to another; returns false if it was not in `from`. */
  transition(approvalId: string, from: ChangeStatus, to: ChangeStatus, patch?: Partial<ChangeRequest>): Promise<boolean>;
}

export interface ApprovalTarget {
  tool: string;
  accountId: string;
  payloadHash: string;
}

export interface ApprovalDecision {
  approvalId: string;
  approvedBy: string;
}

export interface NewChangeRequest extends ApprovalTarget {
  preview: string;
  payload: unknown;
  requestedBy: string;
  /** Per-tool approval window; defaults to 15 minutes. */
  ttlMinutes?: number;
}

export interface ApprovalService {
  /** Records a pending change request. Throws ApprovalDeniedError when writes are not enabled. */
  request(input: NewChangeRequest): Promise<ChangeRequest>;
  /** Claims an approved request for one execution, or throws why it cannot run. */
  consume(approvalId: string, target: ApprovalTarget): Promise<ApprovalDecision>;
  /** Records the outcome of a consumed request. */
  complete(approvalId: string, ok: boolean): Promise<void>;
}

/** The write was refused outright: writes are disabled, or an approver denied it. */
export class ApprovalDeniedError extends Error {
  override readonly name = "ApprovalDeniedError";
}

/** The request exists but nobody has approved it yet. */
export class ApprovalPendingError extends Error {
  override readonly name = "ApprovalPendingError";
}

/** The approval cannot be used: unknown, already used, expired, payload changed, or approver not allowed. */
export class ApprovalInvalidError extends Error {
  override readonly name = "ApprovalInvalidError";
}

/** Default when no approval store is configured: every write is refused. */
export class DenyAllApprovals implements ApprovalService {
  async request(input: NewChangeRequest): Promise<ChangeRequest> {
    throw new ApprovalDeniedError(
      `${input.tool} writes to NetSuite and writes are not enabled in this release. No change was made.`,
    );
  }

  async consume(): Promise<ApprovalDecision> {
    throw new ApprovalDeniedError("Writes are not enabled in this release. No change was made.");
  }

  async complete(): Promise<void> {}
}

export interface StoredApprovalsOptions {
  store: ApprovalStore;
  /** Named approvers (NS_AGENT_APPROVERS). The requester may approve their own change (ADR 0004 decision 2). */
  approvers: ReadonlySet<string>;
  now?: () => number;
  /** How long a request may wait for a decision. */
  pendingTtlMinutes?: number;
  /** Approval window when the tool does not set approvalTtlMinutes. */
  defaultTtlMinutes?: number;
}

const MINUTE = 60_000;

export class StoredApprovals implements ApprovalService {
  private readonly store: ApprovalStore;
  private readonly approvers: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly pendingTtlMinutes: number;
  private readonly defaultTtlMinutes: number;

  constructor(options: StoredApprovalsOptions) {
    this.store = options.store;
    this.approvers = options.approvers;
    this.now = options.now ?? Date.now;
    this.pendingTtlMinutes = options.pendingTtlMinutes ?? 24 * 60;
    this.defaultTtlMinutes = options.defaultTtlMinutes ?? 15;
  }

  private iso(offsetMinutes = 0): string {
    return new Date(this.now() + offsetMinutes * MINUTE).toISOString();
  }

  private expired(request: ChangeRequest): boolean {
    return this.now() >= Date.parse(request.expiresAt);
  }

  get(approvalId: string): Promise<ChangeRequest | undefined> {
    return this.store.get(approvalId);
  }

  list(status?: ChangeStatus): Promise<ChangeRequest[]> {
    return this.store.list(status);
  }

  async request(input: NewChangeRequest): Promise<ChangeRequest> {
    const request: ChangeRequest = {
      approvalId: randomUUID(),
      tool: input.tool,
      accountId: input.accountId,
      payloadHash: input.payloadHash,
      preview: input.preview,
      payload: input.payload,
      requestedBy: input.requestedBy,
      status: "pending",
      ttlMinutes: input.ttlMinutes ?? this.defaultTtlMinutes,
      createdAt: this.iso(),
      expiresAt: this.iso(this.pendingTtlMinutes),
    };
    await this.store.create(request);
    return request;
  }

  /** Approves or denies a pending request. Called by an approval channel (the CLI first), never by the agent. */
  async decide(
    approvalId: string,
    decision: { approver: string; approve: boolean; reason?: string },
  ): Promise<ChangeRequest> {
    const approver = decision.approver.trim();
    if (!approver || !this.approvers.has(approver)) {
      throw new ApprovalInvalidError(`${approver || "(no name)"} is not an approver (NS_AGENT_APPROVERS).`);
    }
    const request = await this.store.get(approvalId);
    if (!request) throw new ApprovalInvalidError(`unknown approval ${approvalId}.`);
    if (request.status !== "pending") throw new ApprovalInvalidError(`approval ${approvalId} is not pending (${request.status}).`);
    if (this.expired(request)) {
      await this.store.transition(approvalId, "pending", "expired");
      throw new ApprovalInvalidError(`approval ${approvalId} expired before a decision; ask the agent to request it again.`);
    }
    const to: ChangeStatus = decision.approve ? "approved" : "denied";
    const patch: Partial<ChangeRequest> = {
      decidedAt: this.iso(),
      decidedBy: approver,
      reason: decision.reason,
      ...(decision.approve ? { expiresAt: this.iso(request.ttlMinutes) } : {}),
    };
    if (!(await this.store.transition(approvalId, "pending", to, patch))) {
      throw new ApprovalInvalidError(`approval ${approvalId} was decided by someone else first.`);
    }
    return { ...request, ...patch, status: to };
  }

  async consume(approvalId: string, target: ApprovalTarget): Promise<ApprovalDecision> {
    const request = await this.store.get(approvalId);
    if (!request) throw new ApprovalInvalidError(`unknown approval ${approvalId}. No change was made.`);
    // Checked before status so a mismatched call never learns or changes anything about someone else's approval.
    if (request.tool !== target.tool || request.accountId !== target.accountId || request.payloadHash !== target.payloadHash) {
      throw new ApprovalInvalidError(
        `approval ${approvalId} does not match this call: the payload changed since it was approved. ` +
          "Call the tool without approvalId to request approval for the new payload. No change was made.",
      );
    }
    switch (request.status) {
      case "pending":
        throw new ApprovalPendingError(`approval ${approvalId} has not been approved yet. No change was made.`);
      case "denied":
        throw new ApprovalDeniedError(
          `approval ${approvalId} was denied by ${request.decidedBy}${request.reason ? `: ${request.reason}` : ""}. No change was made.`,
        );
      case "expired":
        throw new ApprovalInvalidError(`approval ${approvalId} expired. Request it again. No change was made.`);
      case "approved":
        break;
      default:
        throw new ApprovalInvalidError(`approval ${approvalId} was already used. No change was made.`);
    }
    if (this.expired(request)) {
      await this.store.transition(approvalId, "approved", "expired");
      throw new ApprovalInvalidError(`approval ${approvalId} expired. Request it again. No change was made.`);
    }
    if (!request.decidedBy || !this.approvers.has(request.decidedBy)) {
      throw new ApprovalInvalidError(`approval ${approvalId} was given by ${request.decidedBy}, who is no longer an approver.`);
    }
    if (!(await this.store.transition(approvalId, "approved", "executing"))) {
      throw new ApprovalInvalidError(`approval ${approvalId} was already used. No change was made.`);
    }
    return { approvalId, approvedBy: request.decidedBy };
  }

  async complete(approvalId: string, ok: boolean): Promise<void> {
    await this.store.transition(approvalId, "executing", ok ? "executed" : "failed");
  }
}
