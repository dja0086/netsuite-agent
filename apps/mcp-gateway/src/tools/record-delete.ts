import { createHash } from "node:crypto";
import { collect, deleteRecord, suiteqlOffset } from "@ns-agent/ns-client";
import { z } from "zod";
import { ToolInputError, defineTool, type ToolContext, type ToolDef } from "../registry";

/** Record types that may be deleted (ADR 0006). Each needs Full permission on the integration role. */
export const DELETE_RECORD_TYPES = new Set(["customer"]);
const MAX_IDS = 25;
const MAX_CONSECUTIVE_FAILURES = 5;

const recordType = z.string().regex(/^[a-z][a-z0-9_]*$/, "a record type id such as customer");
const ids = z
  .array(z.string().regex(/^\d{1,12}$/, "internal ids (digits)"))
  .min(1)
  .max(MAX_IDS)
  .describe(`Internal ids, at most ${MAX_IDS}`);

interface Snapshot {
  records: Array<{ id: string; name: string; externalId: string | null; lastModified: string }>;
  missing: string[];
  snapshot: string;
}

/** Reads the records (read-only SuiteQL) and fingerprints their last-modified times. */
async function snapshotOf(ctx: ToolContext, type: string, list: string[]): Promise<Snapshot> {
  if (!DELETE_RECORD_TYPES.has(type)) {
    throw new ToolInputError(`deleting ${type} records is not enabled; allowed: ${[...DELETE_RECORD_TYPES].join(", ")}`);
  }
  const dup = list.find((id, i) => list.indexOf(id) !== i);
  if (dup) throw new ToolInputError(`id ${dup} is listed twice`);
  const rows = await collect(
    suiteqlOffset<Record<string, unknown>>(
      ctx.ns,
      `SELECT t.id AS id, t.entityid AS entityid, t.companyname AS companyname, t.externalid AS externalid, ` +
        `TO_CHAR(t.lastmodifieddate, 'YYYY-MM-DD HH24:MI:SS') AS lastmodified FROM ${type} t WHERE t.id IN (${list.join(", ")})`,
    ),
  );
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const records = list
    .filter((id) => byId.has(id))
    .map((id) => {
      const r = byId.get(id)!;
      return {
        id,
        name: String(r.companyname ?? r.entityid ?? ""),
        externalId: r.externalid ? String(r.externalid) : null,
        lastModified: String(r.lastmodified ?? ""),
      };
    });
  const missing = list.filter((id) => !byId.has(id));
  const fingerprint = [...records].sort((a, b) => a.id.localeCompare(b.id)).map((r) => `${r.id}@${r.lastModified}`).join(",");
  return { records, missing, snapshot: createHash("sha256").update(`${type}:${fingerprint}`).digest("hex") };
}

/** The records exactly as previewed, or an error saying why the delete cannot go ahead. */
async function unchanged(ctx: ToolContext, type: string, list: string[], expected: string): Promise<Snapshot> {
  const snap = await snapshotOf(ctx, type, list);
  if (snap.missing.length) throw new ToolInputError(`not found: ${snap.missing.join(", ")}. No change was made.`);
  if (snap.snapshot !== expected) {
    throw new ToolInputError("the records changed since the preview (or the ids differ); preview them again. No change was made.");
  }
  return snap;
}

export const nsRecordDeletePreview = defineTool({
  name: "ns_record_delete_preview",
  title: "Preview a record delete",
  description:
    `Shows the records a delete would remove (name, external id, last modified) and returns a snapshot that ` +
    `ns_record_delete needs. Read-only. Record types: ${[...DELETE_RECORD_TYPES].join(", ")}; at most ${MAX_IDS} ids.`,
  writes: false,
  input: z.object({ recordType, ids }),
  async handler({ recordType: type, ids: list }, ctx) {
    const snap = await snapshotOf(ctx, type, list);
    return { recordType: type, ...snap };
  },
});

export const nsRecordDelete = defineTool({
  name: "ns_record_delete",
  title: "Delete records",
  description:
    "Permanently deletes the listed records. This writes to NetSuite: the first call returns approval_pending with a " +
    "preview and deletes nothing; after a human approves, call again with the same arguments plus approvalId. Pass " +
    "the snapshot from ns_record_delete_preview; if any record changed since, nothing is deleted.",
  writes: true,
  approvalTtlMinutes: 15,
  input: z.object({ recordType, ids, snapshot: z.string().regex(/^[0-9a-f]{64}$/, "the snapshot from ns_record_delete_preview") }),
  async describeChange({ recordType: type, ids: list, snapshot }, ctx) {
    const snap = await unchanged(ctx, type, list, snapshot);
    const items = snap.records
      .map((r) => `${r.id} "${r.name}" (external id ${r.externalId ?? "none"}, last modified ${r.lastModified})`)
      .join("; ");
    return `Permanently delete ${snap.records.length} ${type} records: ${items}. This cannot be undone.`;
  },
  async handler({ recordType: type, ids: list, snapshot }, ctx) {
    // Checked again now: a record edited after the approval must not be deleted.
    await unchanged(ctx, type, list, snapshot);
    const deletedIds: string[] = [];
    const failures: Array<{ id: string; error: string }> = [];
    let consecutive = 0;
    for (const id of list) {
      if (consecutive >= MAX_CONSECUTIVE_FAILURES) break;
      try {
        await deleteRecord(ctx.ns, type, id);
        deletedIds.push(id);
        consecutive = 0;
      } catch (error) {
        failures.push({ id, error: (error as Error).message.slice(0, 300) });
        consecutive++;
      }
    }
    return {
      recordType: type,
      requested: list.length,
      deleted: deletedIds.length,
      failed: failures.length,
      notAttempted: list.length - deletedIds.length - failures.length,
      deletedIds,
      failures,
    };
  },
});

export const recordDeleteTools = [nsRecordDeletePreview, nsRecordDelete] as unknown as ToolDef[];
