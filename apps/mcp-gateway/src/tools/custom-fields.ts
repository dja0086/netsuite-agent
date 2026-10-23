import { NsHttpError, describeRecordSchema, suiteql, summarizeSchema, type FieldSummary } from "@ns-agent/ns-client";
import { FIELD_TYPES, SdfSpecError, appliesToOptions, fieldArtifact, type FieldKind, type SdfArtifact } from "@ns-agent/sdf-gen";
import { z } from "zod";
import { ToolInputError, defineTool, type ToolContext, type ToolDef } from "../registry";
import { exists, objectPath, projectRoot, writeArtifact } from "./sdf-project";

/**
 * SuiteQL tables probed for a script ID. Checked live on the demo account: `item` lists an item field applied only
 * to service items, and `transaction` lists body fields; whether it also lists one applied only to non-sales
 * transactions could not be tested there (no such field exists). `entity` does not list a vendor-only field, so
 * entity fields are probed on every entity table an entity field can apply to. The integration role cannot query
 * employee, partner, job, othername, genericresource, entitygroup or projecttemplate, so those come back unchecked.
 */
const ID_TABLES: Record<FieldKind, readonly string[]> = {
  body: ["transaction"],
  item: ["item"],
  entity: ["customer", "vendor", "contact", "employee", "partner", "job", "othername", "genericresource", "entitygroup", "projecttemplate"],
};
const SCRIPT_ID = /^cust(body|entity|item)_nsagent_[a-z0-9_]+$/;

/**
 * Record types whose REST metadata the label check reads, per applies-to target (labels only matter where the field
 * shows). Targets with no entry are not in the role's metadata catalog and are reported as unchecked.
 */
const LABEL_TYPES: Record<FieldKind, Record<string, string[]>> = {
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

type IdResult = "exists" | "absent" | "unchecked";

/** NetSuite answers a query on an unknown column with HTTP 500 UNEXPECTED_ERROR (seen live on transaction, item, customer). */
const isUnknownColumn = (error: unknown) => error instanceof NsHttpError && error.status === 500 && error.code === "UNEXPECTED_ERROR";

/**
 * Account-wide script ID check, per table. A control query runs first: if the role cannot query the table, it is
 * unchecked. Then a successful probe proves the field exists. A failed probe counts as absent only when it fails
 * the way an unknown column does, twice (a one-off server fault answers the same way); any other failure (throttle,
 * timeout, auth, another HTTP status) leaves the table unchecked, never absent.
 */
async function probeScriptId(ctx: ToolContext, kind: FieldKind, scriptId: string) {
  // Columns cannot be bound, so the identifier is checked here, right before it is placed in the query.
  if (!SCRIPT_ID.test(scriptId)) throw new ToolInputError(`unexpected script ID ${scriptId}`);
  const reason = (error: unknown) => (error as Error).message.slice(0, 80);
  return Promise.all(
    ID_TABLES[kind].map(async (table): Promise<{ table: string; result: IdResult; reason?: string }> => {
      if (!/^[a-z]+$/.test(table)) throw new Error(`bad table ${table}`);
      try {
        await suiteql(ctx.ns, `SELECT t.id FROM ${table} t WHERE ROWNUM <= 1`, { limit: 1 });
      } catch (error) {
        return { table, result: "unchecked", reason: `the role cannot query ${table}: ${reason(error)}` };
      }
      const probe = `SELECT COUNT(t.id) AS n FROM ${table} t WHERE t.${scriptId} IS NOT NULL`;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await suiteql(ctx.ns, probe, { limit: 1 });
          return { table, result: "exists" };
        } catch (error) {
          if (!isUnknownColumn(error)) return { table, result: "unchecked", reason: `probe failed: ${reason(error)}` };
        }
      }
      return { table, result: "absent" };
    }),
  );
}

interface LabelClash {
  recordType: string;
  fieldId: string;
  label: string;
}

/** Reads fresh metadata (no cache: a field deployed minutes ago must show) for the types the field will show on. */
async function checkLabels(ctx: ToolContext, args: FieldArgs, scriptId: string) {
  const byTarget = LABEL_TYPES[args.kind];
  const has = (a: string) => Object.hasOwn(byTarget, a);
  const types = new Set(args.appliesTo.filter(has).flatMap((a) => byTarget[a]!));
  const unchecked: { recordType: string; reason: string }[] = args.appliesTo
    .filter((a) => !has(a))
    .map((a) => ({ recordType: a, reason: "not in the integration role's metadata catalog" }));
  const sameLabel: LabelClash[] = [];
  const label = args.label.trim().toLowerCase();
  const checked: string[] = [];
  await Promise.all(
    [...types].map(async (type) => {
      let fields: FieldSummary[];
      try {
        fields = summarizeSchema(await describeRecordSchema(ctx.ns, type));
      } catch (error) {
        unchecked.push({ recordType: type, reason: (error as Error).message.slice(0, 120) });
        return;
      }
      checked.push(type);
      for (const f of fields) {
        if (f.custom && f.id.toLowerCase() !== scriptId && f.label.trim().toLowerCase() === label) {
          sameLabel.push({ recordType: type, fieldId: f.id, label: f.label });
        }
      }
    }),
  );
  return { checked: checked.sort(), unchecked, sameLabel };
}

async function plan(args: FieldArgs, ctx: ToolContext) {
  const artifact = artifactFor(args);
  const file = artifact.files[0]!;
  const root = await projectRoot();
  const inRepo = await exists(objectPath(root, file.path));
  const [ids, labels] = await Promise.all([probeScriptId(ctx, args.kind, artifact.scriptId), checkLabels(ctx, args, artifact.scriptId)]);
  const existsIn = ids.filter((i) => i.result === "exists").map((i) => i.table);
  const uncheckedTables = ids.filter((i) => i.result === "unchecked");
  const warnings: string[] = [];
  if (inRepo) warnings.push(`${file.path} is already in the SDF project; generating again needs replace: true and changes that field`);
  if (existsIn.length) {
    warnings.push(`${artifact.scriptId} already exists in NetSuite (found on ${existsIn.join(", ")})${inRepo ? "" : " but is not in the SDF project"}`);
  }
  if (uncheckedTables.length) {
    warnings.push(
      `could not prove ${artifact.scriptId} is unused on ${uncheckedTables.map((u) => u.table).join(", ")}; a field there with this ID would be ` +
        "overwritten by the deploy, so the PR reviewer must confirm it does not exist",
    );
  }
  for (const c of labels.sameLabel) warnings.push(`${c.recordType} already has a custom field labelled "${c.label}" (${c.fieldId})`);
  if (labels.unchecked.length) warnings.push(`labels not checked on: ${labels.unchecked.map((u) => u.recordType).join(", ")}`);
  if (args.mandatory) {
    warnings.push(
      `mandatory: every save of a record this field applies to (${args.appliesTo.join(", ")}) fails without a value, ` +
        "in the UI, CSV imports, integrations and ns_import_run",
    );
  }
  return { artifact, inRepo, existsIn, uncheckedTables, ids, labels, warnings };
}

export const nsFieldPlan = defineTool({
  name: "ns_field_plan",
  title: "Plan a custom field",
  description:
    "Validates a custom field spec (transaction body, entity or item field) and builds its SDF XML. Probes the script ID " +
    "on the SuiteQL tables for its kind (scriptIdCheck: exists, absent or unchecked per table) and checks the record types " +
    "it applies to for a field with the same label. Changes nothing anywhere. Returns the script ID, the XML, the manifest " +
    "features it needs, warnings, and ready=true only when every probed table answered absent and the field is not " +
    "already in the project.",
  writes: false,
  input: z.object(fieldInput),
  async handler(args, ctx) {
    const { artifact, inRepo, existsIn, uncheckedTables, ids, labels, warnings } = await plan(args, ctx);
    const file = artifact.files[0]!;
    return {
      scriptId: artifact.scriptId,
      path: `Objects/${file.path}`,
      xml: file.content,
      features: artifact.features,
      appliesToOptions: appliesToOptions(args.kind),
      inSdfProject: inRepo,
      scriptIdCheck: ids,
      labelCheckedRecordTypes: labels.checked,
      labelUncheckedRecordTypes: labels.unchecked,
      labelClashes: labels.sameLabel,
      warnings,
      ready: !inRepo && existsIn.length === 0 && uncheckedTables.length === 0,
    };
  },
});

export const nsFieldGenerate = defineTool({
  name: "ns_field_generate",
  title: "Write a custom field into the SDF project",
  description:
    "Writes the field's SDF XML to netsuite/src/Objects/fields/ and adds the manifest features it needs. Nothing reaches " +
    "NetSuite: the file ships through a pull request and the approved deploy (ADR 0002). Refuses a script ID found in " +
    "NetSuite unless the field is already in the SDF project and replace is true; refuses when the ID could not be checked " +
    "on some table unless acceptUnchecked is true; refuses to overwrite a file unless replace is true, and never writes " +
    "through a symbolic link. Run ns_field_plan " +
    "first and get the user's agreement.",
  writes: false,
  localWrites: true,
  input: z.object({
    ...fieldInput,
    replace: z.boolean().default(false).describe("Overwrite the field's existing file (to change a field this project already owns)"),
    acceptUnchecked: z
      .boolean()
      .default(false)
      .describe("Proceed although the plan could not check the script ID on some tables; only after the user agreed to that risk"),
  }),
  async handler({ replace, acceptUnchecked, ...args }, ctx) {
    const { artifact, inRepo, existsIn, uncheckedTables } = await plan(args, ctx);
    if (inRepo && !replace) {
      throw new ToolInputError(`${artifact.scriptId} is already in the SDF project; pass replace: true to change it`);
    }
    if (existsIn.length && !inRepo) {
      throw new ToolInputError(`${artifact.scriptId} already exists in NetSuite and is not in the SDF project; pick another name`);
    }
    if (uncheckedTables.length && !inRepo && !acceptUnchecked) {
      throw new ToolInputError(
        `could not prove ${artifact.scriptId} is unused on ${uncheckedTables.map((u) => u.table).join(", ")}; ` +
          "ask the user, then pass acceptUnchecked: true if they accept that the PR reviewer confirms it",
      );
    }
    const { written, manifestFeaturesAdded } = await writeArtifact(artifact);
    return {
      scriptId: artifact.scriptId,
      replaced: inRepo,
      written,
      manifestFeaturesAdded,
      uncheckedTables: uncheckedTables.map((u) => u.table),
      next: "Commit these files on a branch and open a pull request; the field reaches NetSuite only through the approved deploy-sdf workflow.",
    };
  },
});

export const customFieldsTools = [nsFieldPlan, nsFieldGenerate] as unknown as ToolDef[];
