import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describeRecordSchema, summarizeSchema, type FieldSummary } from "@ns-agent/ns-client";
import {
  FIELD_TYPES,
  SdfSpecError,
  appliesToOptions,
  fieldArtifact,
  withRequiredFeatures,
  type FieldKind,
  type SdfArtifact,
} from "@ns-agent/sdf-gen";
import { z } from "zod";
import { ToolInputError, defineTool, type ToolContext, type ToolDef } from "../registry";

/** The SDF project's src folder (holds manifest.xml and Objects/). */
const sdfDir = () => process.env.NS_AGENT_SDF_DIR?.trim() || path.resolve("netsuite/src");

/**
 * Record types whose metadata the clash check reads, per applies-to target. Targets with no entry are not in the
 * role's REST metadata catalog (employee, partner, project, fulfilment, receipt, expense report) and are reported
 * as unchecked. The first type of each kind is always read, so a script ID clash shows even for other targets.
 */
const CHECK_TYPES: Record<FieldKind, Record<string, string[]>> = {
  body: {
    sale: ["salesorder", "invoice"],
    purchase: ["purchaseorder", "vendorbill"],
    journal: ["journalentry"],
    opportunity: ["opportunity"],
    customerpayment: ["customerpayment"],
    vendorpayment: ["vendorpayment"],
  },
  entity: { customer: ["customer"], vendor: ["vendor"], contact: ["contact"] },
  item: {
    inventory: ["inventoryitem"],
    noninventory: ["noninventorysaleitem"],
    service: ["servicesaleitem"],
    othercharge: ["otherchargesaleitem"],
    kit: ["kititem"],
    group: ["itemgroup"],
    assembly: ["assemblyitem"],
  },
};
const BASE_TYPE: Record<FieldKind, string> = { body: "salesorder", entity: "customer", item: "inventoryitem" };

const fieldInput = {
  kind: z.enum(["body", "entity", "item"]).describe("body = transaction body field, entity = customer/vendor/contact field, item = item field"),
  name: z
    .string()
    .min(1)
    .max(40)
    .describe("Lowercase snake_case name after the nsagent prefix, at most 21 characters (rush -> custbody_nsagent_rush)"),
  label: z.string().min(1).max(200).describe("What users see on the form"),
  type: z.enum(FIELD_TYPES),
  appliesTo: z
    .array(z.string())
    .min(1)
    .max(10)
    .describe(
      "Where the field shows. body: sale, purchase, journal, opportunity, customerpayment, vendorpayment, itemfulfillment, itemreceipt, expensereport; " +
        "entity: customer, vendor, employee, contact, partner, project; item: inventory, noninventory, service, othercharge, kit, group, assembly",
    ),
  description: z.string().max(4000).optional(),
  help: z.string().max(4000).optional().describe("Field-level help shown to users"),
  mandatory: z.boolean().optional(),
  defaultChecked: z.boolean().optional().describe("CHECKBOX only"),
  selectRecordType: z.string().optional().describe("SELECT/MULTISELECT only: standard record type id, e.g. -2 customer, -4 employee"),
  showInList: z.boolean().optional(),
};

type FieldArgs = z.infer<z.ZodObject<typeof fieldInput>>;

function artifactFor(args: FieldArgs): SdfArtifact {
  try {
    return fieldArtifact(args);
  } catch (error) {
    if (error instanceof SdfSpecError) throw new ToolInputError(error.message);
    throw error;
  }
}

async function projectRoot(): Promise<string> {
  try {
    const root = await realpath(sdfDir());
    await stat(path.join(root, "manifest.xml"));
    return root;
  } catch {
    throw new ToolInputError(`the SDF project folder ${sdfDir()} has no manifest.xml (NS_AGENT_SDF_DIR)`);
  }
}

/** Resolves an artifact path under Objects/, refusing anything that would land outside it. */
function objectPath(root: string, rel: string): string {
  const objects = path.join(root, "Objects");
  const full = path.resolve(objects, rel);
  if (!full.startsWith(objects + path.sep)) throw new ToolInputError(`refusing to write outside ${objects}`);
  return full;
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

interface Clash {
  recordType: string;
  fieldId: string;
  label: string;
}

/** Reads fresh metadata (no cache: a field deployed minutes ago must show) for the types the field applies to. */
async function checkAccount(ctx: ToolContext, args: FieldArgs, scriptId: string) {
  const byTarget = CHECK_TYPES[args.kind];
  const types = new Set([BASE_TYPE[args.kind], ...args.appliesTo.flatMap((a) => byTarget[a] ?? [])]);
  const uncheckedTargets = args.appliesTo.filter((a) => !byTarget[a]);
  const results = await Promise.all(
    [...types].map(async (type) => {
      try {
        return { type, fields: summarizeSchema(await describeRecordSchema(ctx.ns, type)) as FieldSummary[] };
      } catch (error) {
        return { type, error: (error as Error).message.slice(0, 120) };
      }
    }),
  );
  const collisions: Clash[] = [];
  const sameLabel: Clash[] = [];
  const checkedRecordTypes: string[] = [];
  const uncheckedRecordTypes: { recordType: string; reason: string }[] = uncheckedTargets.map((t) => ({
    recordType: t,
    reason: "not in the integration role's metadata catalog",
  }));
  const label = args.label.trim().toLowerCase();
  for (const r of results) {
    if (!r.fields) {
      uncheckedRecordTypes.push({ recordType: r.type, reason: r.error ?? "metadata not readable" });
      continue;
    }
    checkedRecordTypes.push(r.type);
    for (const f of r.fields) {
      if (f.id.toLowerCase() === scriptId) collisions.push({ recordType: r.type, fieldId: f.id, label: f.label });
      else if (f.custom && f.label.trim().toLowerCase() === label) sameLabel.push({ recordType: r.type, fieldId: f.id, label: f.label });
    }
  }
  return { checkedRecordTypes, uncheckedRecordTypes, collisions, sameLabel };
}

async function plan(args: FieldArgs, ctx: ToolContext) {
  const artifact = artifactFor(args);
  const file = artifact.files[0]!;
  const root = await projectRoot();
  const inRepo = await exists(objectPath(root, file.path));
  const account = await checkAccount(ctx, args, artifact.scriptId);
  const warnings: string[] = [];
  if (inRepo) warnings.push(`${file.path} is already in the SDF project; generating again needs replace: true and changes that field`);
  for (const c of account.collisions) {
    warnings.push(`${c.fieldId} already exists in NetSuite (on ${c.recordType}, label "${c.label}")${inRepo ? "" : " but not in the SDF project"}`);
  }
  for (const c of account.sameLabel) warnings.push(`${c.recordType} already has a custom field labelled "${c.label}" (${c.fieldId})`);
  if (account.uncheckedRecordTypes.length) {
    warnings.push(`not checked: ${account.uncheckedRecordTypes.map((u) => u.recordType).join(", ")}; the deploy's server validation is the final check`);
  }
  return { artifact, inRepo, account, warnings };
}

export const nsFieldPlan = defineTool({
  name: "ns_field_plan",
  title: "Plan a custom field",
  description:
    "Validates a custom field spec (transaction body, entity or item field), builds its SDF XML and checks the account's " +
    "record metadata for a field with the same script ID or label. Changes nothing anywhere. Returns the script ID, the " +
    "XML, the manifest features it needs, what was checked and what could not be, and ready=true when nothing clashes.",
  writes: false,
  input: z.object(fieldInput),
  async handler(args, ctx) {
    const { artifact, inRepo, account, warnings } = await plan(args, ctx);
    const file = artifact.files[0]!;
    return {
      scriptId: artifact.scriptId,
      path: `Objects/${file.path}`,
      xml: file.content,
      features: artifact.features,
      appliesToOptions: appliesToOptions(args.kind),
      inSdfProject: inRepo,
      checkedRecordTypes: account.checkedRecordTypes,
      uncheckedRecordTypes: account.uncheckedRecordTypes,
      collisions: account.collisions,
      warnings,
      ready: account.collisions.length === 0 && !inRepo,
    };
  },
});

export const nsFieldGenerate = defineTool({
  name: "ns_field_generate",
  title: "Write a custom field into the SDF project",
  description:
    "Writes the field's SDF XML to netsuite/src/Objects/fields/ and adds the manifest features it needs. Nothing reaches " +
    "NetSuite: the file ships through a pull request and the approved deploy (ADR 0002). Refuses a script ID that already " +
    "exists in NetSuite unless the field is already in the SDF project and replace is true; refuses to overwrite a file " +
    "unless replace is true. Run ns_field_plan first and get the user's agreement.",
  writes: false,
  localWrites: true,
  input: z.object({
    ...fieldInput,
    replace: z.boolean().default(false).describe("Overwrite the field's existing file (to change a field this project already owns)"),
  }),
  async handler({ replace, ...args }, ctx) {
    const { artifact, inRepo, account } = await plan(args, ctx);
    if (inRepo && !replace) {
      throw new ToolInputError(`${artifact.scriptId} is already in the SDF project; pass replace: true to change it`);
    }
    if (account.collisions.length && !inRepo) {
      throw new ToolInputError(`${artifact.scriptId} already exists in NetSuite and is not in the SDF project; pick another name`);
    }
    const root = await projectRoot();
    const written: string[] = [];
    for (const f of artifact.files) {
      const full = objectPath(root, f.path);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, f.content);
      written.push(`Objects/${f.path}`);
    }
    const manifestPath = path.join(root, "manifest.xml");
    const before = await readFile(manifestPath, "utf8");
    const after = withRequiredFeatures(before, artifact.features);
    const manifestFeaturesAdded = artifact.features.filter((f) => !new RegExp(`<feature required="true">${f}</feature>`).test(before));
    if (after !== before) {
      await writeFile(manifestPath, after);
      written.push("manifest.xml");
    }
    return {
      scriptId: artifact.scriptId,
      replaced: inRepo,
      written,
      manifestFeaturesAdded,
      uncheckedRecordTypes: account.uncheckedRecordTypes,
      next: "Commit these files on a branch and open a pull request; the field reaches NetSuite only through the approved deploy-sdf workflow.",
    };
  },
});

export const customFieldsTools = [nsFieldPlan, nsFieldGenerate] as unknown as ToolDef[];
