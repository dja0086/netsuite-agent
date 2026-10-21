# ADR 0004: Approval service for data writes

**Status:** proposed · 2026-10-20 · replaces `DenyAllApprovals` (Phase 2, step 9)

## Context

ADR 0002 sends schema changes through SDF pull requests. Data writes (saving a search first, record imports later) go through approval-gated tool calls instead. Today every write tool calls `ApprovalService.require({ tool, summary, payloadHash })` and `DenyAllApprovals` refuses. That interface has four gaps:

1. **The approver cannot judge the change.** `summary` is the tool title ("Save search"), not what will be written.
2. **It blocks.** `require()` holds the tool call open until a human decides. MCP tool calls time out, and an agent cannot wait minutes inside one call.
3. **No named approver.** Nothing establishes who approved, or that they may approve.
4. **No replay protection.** Nothing stops an approval being reused, used late, or used against a different account or payload.

## Decision

### Two-step flow: request, then execute

1. The agent calls a write tool. The gateway builds the **change request**: the canonical payload, the target account, and a human-readable preview produced by the tool (`describeChange(args, ctx)`, which may read NetSuite but never write). It stores the request as `pending` and returns `APPROVAL_PENDING` with the `approvalId`, the preview and its expiry. **The handler does not run.**
2. A named approver approves or denies it out of band (see channels below), seeing the same preview and the payload hash.
3. The agent calls the same tool again with the same arguments plus `approvalId`. The gateway executes only if **all** of these hold:
   - the request exists and is `approved`;
   - `payloadHash` recomputed from (tool, args without `approvalId`, account id) equals the stored hash;
   - the request has not expired (default 15 minutes after approval);
   - it has not been used (single use, enforced atomically: `approved -> executing` in one step);
   - the approver is on the allowlist for this tool and, when `NS_AGENT_DISTINCT_APPROVER=1`, is not the requester.
4. Execution is audited with `approvalId`, `approvedBy` and `payloadHash`. The request moves to `executed` or `failed`; it is never reusable.

Any mismatch returns `APPROVAL_INVALID` with the reason (changed payload, expired, used, wrong account) and runs nothing.

### Payload binding

`payloadHash = sha256(canonicalJson({ tool, args, accountId }))`. `approvalId` is excluded from `args` before hashing. Binding the account id means a demo approval can never run against production. For updates to existing records, the tool must include the record's `lastModifiedDate` in its args, and the handler must refuse if NetSuite's value differs. That way an approval granted on one version of a record cannot apply to a later version.

### Interfaces (sketch)

```ts
interface ChangeRequest {
  approvalId: string;            // random, unguessable (crypto.randomUUID)
  tool: string;
  accountId: string;
  payloadHash: string;
  preview: string;               // what the approver reads; no secrets, redaction applied
  requestedBy: string;           // the agent session's user (NS_AGENT_USER)
  status: "pending" | "approved" | "denied" | "executing" | "executed" | "failed" | "expired";
  createdAt: string; decidedAt?: string; decidedBy?: string; reason?: string; expiresAt: string;
}

interface ApprovalStore {        // atomic status transitions; the single-use rule depends on it
  create(r: ChangeRequest): Promise<void>;
  get(id: string): Promise<ChangeRequest | undefined>;
  transition(id: string, from: ChangeRequest["status"], to: ChangeRequest["status"], patch?: Partial<ChangeRequest>): Promise<boolean>;
}

interface ApprovalChannel {      // how a human sees and decides a request
  notify(r: ChangeRequest): Promise<void>;
}

interface ToolDef { /* existing fields */ describeChange?(args, ctx): Promise<string>; }  // required when writes: true
```

`ApprovalService.require()` becomes `request()` plus `consume(approvalId, payloadHash)`. The validator requires `describeChange` on every write tool.

### Channels

The store and the rules above do not depend on the channel. Channels, in the order they would ship:

| Channel | Approver identity | Fit |
| --- | --- | --- |
| **CLI**: `pnpm approvals list / show <id> / approve <id> / deny <id> --reason` | Weak: local OS user checked against `NS_AGENT_APPROVERS` | Demo and sandbox only. Ships first, no new infrastructure. |
| **GitHub issue**: the gateway opens an issue holding the preview and hash; the approver comments `/approve <hash prefix>` | Strong: the GitHub login, checked against the allowlist through the API | First channel for production use. Reuses CODEOWNERS identities, and the issue doubles as the audit trail. |
| **Slack approval card** | Strong: SSO-backed Slack user | Later, if approvers live in Slack. |

MCP elicitation (the host asks the user inside the agent session) is **not** an approval channel. It gives no authenticated identity, and in autonomous hosts the person or process answering may not be a human. It may be used to tell the user an approval is pending.

### Store

Phase 2: a local SQLite file (`NS_AGENT_APPROVALS_DB`, default `audit/approvals.sqlite`). Its transactions make `transition()` atomic for the gateway process and the CLI, which share the file on one machine. Production: the same interface backed by the deployment's database.

### Audit

New audit events: `approval.requested`, `approval.decided`, `approval.consumed`, `approval.rejected` (with reason). Each event records `approvalId`, `payloadHash`, `tool` and the actor, but never the payload itself, which stays in the store only.

## Consequences

- Write tools take two calls. The agent's skill text has to explain this: call, show the preview, wait for the user to say it was approved, then call again with `approvalId`.
- Every write tool must have evals proving that it runs nothing without approval, with a changed payload, after expiry, or a second time.
- The first channel is the CLI, so Phase 2 writes run on demo or sandbox accounts only. `NS_TARGET_KIND=production` refuses the CLI channel at start-up.
- `DenyAllApprovals` stays as the default whenever no store is configured.

## Open questions

1. Which channel goes to production first: GitHub issues (recommended) or Slack?
2. Should distinct requester and approver be required everywhere (recommended for production) or only in production?
3. Is the default approval window of 15 minutes right? Should it differ per tool?
