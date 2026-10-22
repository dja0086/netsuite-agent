import { z } from "zod";
import { SELECT_RECORD_TYPES } from "./select-record-types";
import { formText, plainText } from "./text";
import { SdfSpecError, elements, flag, sortedUnique, type SdfArtifact } from "./xml";

/**
 * Script ID limits from the SDF XML reference count the whole attribute value, prefix included:
 * transactionbodycustomfield 38, itemcustomfield 38, entitycustomfield 40.
 * With the nsagent prefixes that leaves 21 characters for the name in every case.
 */
export const FIELD_KINDS = {
  body: { object: "transactionbodycustomfield", prefix: "custbody_nsagent_", maxLength: 38 },
  entity: { object: "entitycustomfield", prefix: "custentity_nsagent_", maxLength: 40 },
  item: { object: "itemcustomfield", prefix: "custitem_nsagent_", maxLength: 38 },
} as const;
export type FieldKind = keyof typeof FIELD_KINDS;

/** Types the agent may create. Left out on purpose: PASSWORD, INLINEHTML, RICHTEXT, HELP, IMAGE, DOCUMENT, CLOBTEXT. */
export const FIELD_TYPES = [
  "CHECKBOX",
  "CURRENCY",
  "DATE",
  "DATETIMETZ",
  "EMAIL",
  "FLOAT",
  "INTEGER",
  "MULTISELECT",
  "PERCENT",
  "PHONE",
  "SELECT",
  "TEXT",
  "TEXTAREA",
  "URL",
] as const;

/** Applies-to flags per kind: element name and the manifest feature the SDF reference ties it to. */
const BODY_APPLIES = {
  sale: { el: "bodysale" },
  purchase: { el: "bodypurchase", feature: "ACCOUNTING" },
  journal: { el: "bodyjournal", feature: "ACCOUNTING" },
  opportunity: { el: "bodyopportunity", feature: "OPPORTUNITIES" },
  customerpayment: { el: "bodycustomerpayment", feature: "RECEIVABLES" },
  vendorpayment: { el: "bodyvendorpayment", feature: "PAYABLES" },
  itemfulfillment: { el: "bodyitemfulfillment", feature: "ACCOUNTING" },
  itemreceipt: { el: "bodyitemreceipt", feature: "ADVRECEIVING" },
  expensereport: { el: "bodyexpensereport", feature: "EXPREPORTS" },
} as const;

const ENTITY_APPLIES = {
  customer: { el: "appliestocustomer" },
  vendor: { el: "appliestovendor", feature: "ACCOUNTING" },
  employee: { el: "appliestoemployee" },
  contact: { el: "appliestocontact" },
  partner: { el: "appliestopartner", feature: "CRM" },
  project: { el: "appliestoproject", feature: "JOBS" },
} as const;

const ITEM_APPLIES = {
  inventory: { el: "appliestoinventory", feature: "INVENTORY" },
  noninventory: { el: "appliestononinventory" },
  service: { el: "appliestoservice" },
  othercharge: { el: "appliestoothercharge" },
  kit: { el: "appliestokit" },
  group: { el: "appliestogroup" },
  assembly: { el: "appliestoitemassembly", feature: "ASSEMBLIES" },
} as const;

type AppliesMap = Record<string, { el: string; feature?: string }>;
const APPLIES: Record<FieldKind, AppliesMap> = { body: BODY_APPLIES, entity: ENTITY_APPLIES, item: ITEM_APPLIES };

/** Lists the applies-to targets a kind accepts (for plan tools and error messages). */
export const appliesToOptions = (kind: FieldKind) => Object.keys(APPLIES[kind]);

const NAME = /^[a-z0-9]+(_[a-z0-9]+)*$/;

export const FieldSpec = z
  .object({
    kind: z.enum(["body", "entity", "item"]),
    /** The part after the nsagent prefix, e.g. "rush" for custbody_nsagent_rush. */
    name: z.string().regex(NAME, "name is lowercase letters and digits separated by single underscores"),
    label: formText(200).pipe(z.string().trim().min(1)),
    type: z.enum(FIELD_TYPES),
    appliesTo: z.array(z.string()).min(1),
    description: plainText(4000).default(""),
    help: formText(4000).default(""),
    mandatory: z.boolean().default(false),
    /** CHECKBOX only. */
    defaultChecked: z.boolean().default(false),
    /** Standard record type id from SELECT_RECORD_TYPES (e.g. "-2" customer); required for SELECT and MULTISELECT. */
    selectRecordType: z
      .string()
      .refine(
        (v) => Object.hasOwn(SELECT_RECORD_TYPES, v),
        "selectRecordType must be a standard record type id from the SDF list (e.g. -2 customer, -4 employee); custom lists are not supported yet",
      )
      .optional(),
    showInList: z.boolean().default(false),
  })
  .strict()
  .superRefine((f, ctx) => {
    const k = FIELD_KINDS[f.kind];
    const max = k.maxLength - k.prefix.length;
    if (f.name.length > max) {
      ctx.addIssue({ code: "custom", path: ["name"], message: `name is at most ${max} characters (${k.prefix}<name> must fit ${k.maxLength})` });
    }
    const allowed = APPLIES[f.kind];
    for (const [i, a] of f.appliesTo.entries()) {
      if (!Object.hasOwn(allowed, a)) {
        ctx.addIssue({ code: "custom", path: ["appliesTo", i], message: `${f.kind} fields apply to: ${Object.keys(allowed).join(", ")}` });
      }
    }
    if (new Set(f.appliesTo).size !== f.appliesTo.length) {
      ctx.addIssue({ code: "custom", path: ["appliesTo"], message: "appliesTo has duplicates" });
    }
    const isSelect = f.type === "SELECT" || f.type === "MULTISELECT";
    if (isSelect && !f.selectRecordType) {
      ctx.addIssue({ code: "custom", path: ["selectRecordType"], message: "SELECT and MULTISELECT fields need selectRecordType" });
    }
    if (!isSelect && f.selectRecordType) {
      ctx.addIssue({ code: "custom", path: ["selectRecordType"], message: "selectRecordType is only for SELECT and MULTISELECT fields" });
    }
    if (f.type !== "CHECKBOX" && f.defaultChecked) {
      ctx.addIssue({ code: "custom", path: ["defaultChecked"], message: "defaultChecked is only for CHECKBOX fields" });
    }
    if (f.type === "CHECKBOX" && f.mandatory) {
      ctx.addIssue({ code: "custom", path: ["mandatory"], message: "a CHECKBOX field cannot be mandatory" });
    }
  });
export type FieldSpec = z.output<typeof FieldSpec>;

export const fieldScriptId = (kind: FieldKind, name: string) => `${FIELD_KINDS[kind].prefix}${name}`;

/** Builds the SDF object for one custom field. Throws SdfSpecError on an invalid spec. */
export function fieldArtifact(input: z.input<typeof FieldSpec>): SdfArtifact {
  const parsed = FieldSpec.safeParse(input);
  if (!parsed.success) {
    throw new SdfSpecError(parsed.error.issues.map((i) => `${i.path.join(".") || "spec"}: ${i.message}`).join("; "));
  }
  const f = parsed.data;
  const kind = FIELD_KINDS[f.kind];
  const scriptId = fieldScriptId(f.kind, f.name);
  const applies = APPLIES[f.kind];
  const chosen = new Set(f.appliesTo);

  // Only the chosen flags are written: they default to F, and a feature-bound flag in the file
  // (even set to F) makes SDF expect that feature in the manifest.
  const appliesLines = Object.entries(applies)
    .filter(([key]) => chosen.has(key))
    .map(([, a]) => [a.el, "T"] as [string, string]);
  const features = f.appliesTo.map((a) => applies[a]?.feature).filter((x): x is string => !!x);
  const selectFeature = f.selectRecordType ? SELECT_RECORD_TYPES[f.selectRecordType] : null;
  if (selectFeature) features.push(selectFeature);

  const lines: [string, string | undefined][] = [
    ["label", f.label],
    ["fieldtype", f.type],
    ...(f.selectRecordType ? [["selectrecordtype", f.selectRecordType] as [string, string]] : []),
    ["description", f.description],
    ["help", f.help],
    ["storevalue", "T"],
    ["displaytype", "NORMAL"],
    ["ismandatory", flag(f.mandatory)],
    ["defaultchecked", flag(f.defaultChecked)],
    ["showinlist", flag(f.showInList)],
    ["globalsearch", "F"],
    ["encryptatrest", "F"],
    ["accesslevel", "2"],
    ["searchlevel", "2"],
    ...appliesLines,
    ...(f.kind === "item" ? [["itemsubtype", "BOTH"] as [string, string]] : []),
  ];

  const content = `<${kind.object} scriptid="${scriptId}">\n${elements(lines)}\n</${kind.object}>\n`;
  return { scriptId, files: [{ path: `fields/${scriptId}.xml`, content }], features: sortedUnique(features) };
}
