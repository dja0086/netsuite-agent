export interface ApprovalRequest {
  tool: string;
  /** One line a human can judge, e.g. "Save search 'Open AR > 60 days' (customsearch_nsagent_ar60)". */
  summary: string;
  /** Hash of the exact payload; the approval is only valid for this payload. */
  payloadHash: string;
}

export interface ApprovalDecision {
  approvalId: string;
  approvedBy: string;
}

export interface ApprovalService {
  /** Resolves when a named human approves; rejects with ApprovalDeniedError otherwise. */
  require(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export class ApprovalDeniedError extends Error {
  override readonly name = "ApprovalDeniedError";
}

/**
 * Phase 1 ships read-only: every write is refused. Phase 2 replaces this with an approval
 * service that asks a named human (for example through MCP elicitation or a chat approval card)
 * and binds the decision to `payloadHash`.
 */
export class DenyAllApprovals implements ApprovalService {
  async require(request: ApprovalRequest): Promise<ApprovalDecision> {
    throw new ApprovalDeniedError(
      `${request.tool} writes to NetSuite and writes are not enabled in this release. No change was made.`,
    );
  }
}
