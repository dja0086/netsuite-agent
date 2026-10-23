import { createHash } from "node:crypto";
import {
  SdfSpecError,
  TEMPLATE_RECORDS,
  TEMPLATE_SOURCE_MAX,
  templateArtifact,
  templateReviewPoints,
  type SdfArtifact,
  type TemplateRecord,
} from "@ns-agent/sdf-gen";
import { z } from "zod";
import { ToolInputError, defineTool, type ToolDef } from "../registry";
import { exists, objectPath, projectRoot, writeArtifact } from "./sdf-project";

const RECORDS = Object.keys(TEMPLATE_RECORDS) as [TemplateRecord, ...TemplateRecord[]];

export const nsPdfTemplateGenerate = defineTool({
  name: "ns_pdf_template_generate",
  title: "Write a PDF template into the SDF project",
  description:
    "Writes an approved Advanced PDF/HTML template draft (BFO + FreeMarker) as an advancedpdftemplate object " +
    "(custtmpl_nsagent_<record>_<purpose>) and its .template.xml under netsuite/src/Objects/templates/, and adds the " +
    "manifest features it needs. Never calls NetSuite and never marks the template preferred: it ships through a pull " +
    "request and the approved deploy (ADR 0002). Refuses sources that fail the sdf-gen template lint (non-NetSuite " +
    "addresses, FreeMarker inside src/href/url(), includes, ?eval/?interpret/?new), refuses to overwrite a template " +
    "file unless replace is true, and never writes through a symbolic link. Returns the files written, the source's " +
    "sha256 and the resource addresses and assignments the PR reviewer must read. Generate only after the user agreed " +
    "the draft (ideally after previewing it).",
  writes: false,
  localWrites: true,
  input: z.object({
    record: z.enum(RECORDS).describe("Transaction type the template prints"),
    purpose: z
      .string()
      .min(1)
      .max(40)
      .describe("Lowercase snake_case name after the record, at most 40 characters (standard -> custtmpl_nsagent_invoice_standard)"),
    title: z.string().min(3).max(297).describe("Template name shown in NetSuite, e.g. NS Agent - Invoice"),
    description: z.string().max(4000).optional(),
    source: z.string().min(1).max(TEMPLATE_SOURCE_MAX).describe("The agreed BFO + FreeMarker source, exactly as previewed"),
    replace: z.boolean().default(false).describe("Overwrite the template's existing files (to change a template this project already owns)"),
  }),
  async handler({ replace, ...spec }) {
    let artifact: SdfArtifact;
    try {
      artifact = templateArtifact(spec);
    } catch (error) {
      if (error instanceof SdfSpecError) throw new ToolInputError(error.message);
      throw error;
    }
    const root = await projectRoot();
    const inRepo = (await Promise.all(artifact.files.map((f) => exists(objectPath(root, f.path))))).some(Boolean);
    if (inRepo && !replace) {
      throw new ToolInputError(`${artifact.scriptId} is already in the SDF project; pass replace: true to change it`);
    }
    const { written, manifestFeaturesAdded } = await writeArtifact(artifact);
    return {
      scriptId: artifact.scriptId,
      replaced: inRepo,
      written,
      manifestFeaturesAdded,
      sourceSha256: createHash("sha256").update(spec.source).digest("hex"),
      review: templateReviewPoints(spec.source),
      next:
        "Open a pull request with these files (ns_change_open_pr, once the user agrees). The reviewer reads every resource " +
        "address and assignment listed in review; the template reaches NetSuite only through the approved deploy-sdf workflow.",
    };
  },
});

export const pdfTemplateGenerateTools = [nsPdfTemplateGenerate] as unknown as ToolDef[];
