import { z } from "zod";
import { SdfSpecError, elements, type SdfArtifact } from "./xml";

/**
 * Transaction types a template may target: the standard template it derives from and the print
 * type/transaction type pair the object carries. CUSTINVC/TRANSACTION was checked against a template
 * imported from the demo account; the others follow the SDF reference's advancedpdftemplate_standard list.
 * Each matches a transaction type the integration role can View, so ns_pdf_preview can render it.
 */
export const TEMPLATE_RECORDS = {
  invoice: { standard: "STDTMPLCUSTINVC", trantype: "CUSTINVC", feature: "ACCOUNTING" },
  salesorder: { standard: "STDTMPLSALESORD", trantype: "SALESORD", feature: "SALESORDERS" },
  estimate: { standard: "STDTMPLQUOTE", trantype: "ESTIMATE", feature: "ESTIMATES" },
  creditmemo: { standard: "STDTMPLCUSTCRED", trantype: "CUSTCRED", feature: "ACCOUNTING" },
  purchaseorder: { standard: "STDTMPLPURCHORD", trantype: "PURCHORD", feature: "PURCHASEORDERS" },
} as const;
export type TemplateRecord = keyof typeof TEMPLATE_RECORDS;

const TEMPLATE_PREFIX = "custtmpl_nsagent_";
/** advancedpdftemplate scriptid limit from the SDF reference, prefix included. */
const TEMPLATE_ID_MAX = 98;
/** Generous for a hand-written template; the standard invoice template is about 9 KB. */
export const TEMPLATE_SOURCE_MAX = 200_000;

const NAME = /^[a-z0-9]+(_[a-z0-9]+)*$/;

export const TemplateSpec = z
  .object({
    record: z.enum(Object.keys(TEMPLATE_RECORDS) as [TemplateRecord, ...TemplateRecord[]]),
    /** The part after the record, e.g. "standard" for custtmpl_nsagent_invoice_standard. */
    purpose: z.string().regex(NAME, "purpose is lowercase letters and digits separated by single underscores").max(40),
    title: z.string().trim().min(3).max(297),
    description: z.string().max(4000).default(""),
    /** BFO + FreeMarker source, written verbatim to <scriptid>.template.xml. */
    source: z.string().max(TEMPLATE_SOURCE_MAX),
  })
  .strict()
  .superRefine((t, ctx) => {
    const id = templateScriptId(t.record, t.purpose);
    if (id.length > TEMPLATE_ID_MAX) {
      ctx.addIssue({ code: "custom", path: ["purpose"], message: `script ID ${id} is longer than ${TEMPLATE_ID_MAX} characters` });
    }
    const src = t.source.trimStart();
    if (!src.startsWith("<?xml")) ctx.addIssue({ code: "custom", path: ["source"], message: "source must start with <?xml" });
    if (!/<!DOCTYPE\s+pdf\b/.test(src)) ctx.addIssue({ code: "custom", path: ["source"], message: "source needs the BFO <!DOCTYPE pdf ...> declaration" });
    if (!/<pdf(set)?[\s>]/.test(src)) ctx.addIssue({ code: "custom", path: ["source"], message: "source needs a <pdf> or <pdfset> root" });
    // A template must stand alone: SDF does not validate template contents, and includes pull in files the PR does not show.
    if (/<#(include|import)\b/.test(src)) ctx.addIssue({ code: "custom", path: ["source"], message: "<#include> and <#import> are not allowed" });
  });
export type TemplateSpec = z.output<typeof TemplateSpec>;

export const templateScriptId = (record: TemplateRecord, purpose: string) => `${TEMPLATE_PREFIX}${record}_${purpose}`;

/**
 * Builds the advancedpdftemplate object and its .template.xml. The template is never marked preferred:
 * that would change the default printout for every user of the transaction type.
 */
export function templateArtifact(input: z.input<typeof TemplateSpec>): SdfArtifact {
  const parsed = TemplateSpec.safeParse(input);
  if (!parsed.success) {
    throw new SdfSpecError(parsed.error.issues.map((i) => `${i.path.join(".") || "spec"}: ${i.message}`).join("; "));
  }
  const t = parsed.data;
  const rec = TEMPLATE_RECORDS[t.record];
  const scriptId = templateScriptId(t.record, t.purpose);
  const object =
    `<advancedpdftemplate scriptid="${scriptId}" standard="${rec.standard}">\n` +
    elements([
      ["title", t.title],
      ["description", t.description],
      ["displaysourcecode", "T"],
      ["isinactive", "F"],
      ["preferred", "F"],
      ["printtype", "TRANSACTION"],
      ["trantype", rec.trantype],
    ]) +
    "\n</advancedpdftemplate>\n";
  const source = t.source.endsWith("\n") ? t.source : `${t.source}\n`;
  return {
    scriptId,
    files: [
      { path: `templates/${scriptId}.xml`, content: object },
      { path: `templates/${scriptId}.template.xml`, content: source },
    ],
    features: ["ADVANCEDPRINTING", rec.feature].sort(),
  };
}
