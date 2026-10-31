import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import { NsHttpError, callRestlet } from "@ns-agent/ns-client";
import { z } from "zod";
import { ToolInputError, defineTool, type ToolDef } from "../registry";

const exportDir = () => process.env.NS_AGENT_EXPORT_DIR?.trim() || path.resolve("exports");

/** The preview RESTlet (netsuite/src/FileCabinet/SuiteScripts/ns_agent/restlets/pdf_rl.js). */
const RESTLET = { scriptId: "customscript_ns_agent_pdf_rl", deployId: "customdeploy_ns_agent_pdf_rl" } as const;

/** Same allow-list and limits as the RESTlet, so bad input is refused before it costs a NetSuite call. */
export const PREVIEW_RECORD_TYPES = ["invoice", "salesorder", "estimate", "creditmemo", "purchaseorder", "vendorbill"] as const;
const MAX_TEMPLATE_CHARS = 100_000;
/** BFO's root elements; anything else fails inside NetSuite with a less helpful message. */
const PDF_ROOT = /<pdf(set)?[\s>]/;

interface PreviewResponse {
  fileName?: unknown;
  base64?: unknown;
  remainingUsage?: unknown;
}

/**
 * Page count from the PDF's page tree: the largest /Count on a /Type /Pages node (the root holds the total).
 * BFO writes the page tree uncompressed; undefined when it cannot be read (e.g. inside a compressed object stream).
 */
export function pdfPageCount(pdf: Buffer): number | undefined {
  const text = pdf.toString("latin1");
  let pages: number | undefined;
  for (const m of text.matchAll(/<<((?:(?!>>)[\s\S])*?\/Type\s*\/Pages\b(?:(?!>>)[\s\S])*?)>>/g)) {
    const count = /\/Count\s+(\d+)/.exec(m[1]!);
    if (count) pages = Math.max(pages ?? 0, Number(count[1]));
  }
  if (pages !== undefined) return pages;
  const leaves = text.match(/\/Type\s*\/Page(?![s\w])/g)?.length;
  return leaves || undefined;
}

/** Turns the RESTlet's and NetSuite's error codes into messages the agent can act on. */
function previewError(error: NsHttpError, recordType: string, recordId: number): Error {
  // ToolInputError messages reach the agent; a bare NsHttpError reaches it as "NetSuite rejected the request".
  switch (error.code) {
    case "NS_AGENT_BAD_INPUT":
      // Input errors and the rendered-resource check (addresses outside NetSuite, @import, entities).
      return new ToolInputError(`NetSuite refused the preview: ${error.message}`);
    case "NS_AGENT_USAGE_LOW":
      return new ToolInputError(`NetSuite ran low on script usage units while rendering (${error.message}); try again, or simplify the template.`);
    case "NS_AGENT_UNKNOWN_ACTION":
      return new ToolInputError("The PDF preview RESTlet on this account does not support preview; deploy the current netsuite/ project.");
    case "RCRD_DSNT_EXIST":
      return new ToolInputError(`${recordType} ${recordId} does not exist, or the integration role cannot see it.`);
    case "INVALID_TRANS_TYP":
      return new ToolInputError(`${recordId} is the internal id of a different transaction type, not ${recordType}.`);
    case "INSUFFICIENT_PERMISSION":
      return new ToolInputError(`The integration role cannot load ${recordType} ${recordId}: ${error.message}`);
    case "SSS_INVALID_SCRIPTLET_ID":
    case "INVALID_SCRIPTLET_ID":
      return new ToolInputError("The PDF preview RESTlet (customscript_ns_agent_pdf_rl) is not deployed on this account.");
    case "USER_ERROR":
      // XML and BFO layout errors, e.g. "Error Parsing XML: The element type "p" must be terminated ...".
      return new ToolInputError(`The template did not render: ${error.message}`);
    case "UNEXPECTED_ERROR":
      // Seen live: N/render reports FreeMarker errors (an unknown built-in, a bad directive) this way, with no detail.
      return new ToolInputError(
        "The template did not render: NetSuite reported UNEXPECTED_ERROR, which is how it reports most FreeMarker errors " +
          "(an unknown built-in, a bad directive or expression). Check the ${...} expressions and <#...> directives you changed. " +
          "If a template that rendered before fails this way unchanged, NetSuite itself failed: try again.",
      );
    default:
      return error;
  }
}

/** Writes the PDF without following a symbolic link at its path; the name is new, so an existing file is refused. */
async function writeNew(file: string, content: Buffer): Promise<void> {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

export const nsPdfPreview = defineTool({
  name: "ns_pdf_preview",
  title: "Preview a PDF template",
  description:
    "Renders a draft Advanced PDF/HTML template (BFO XML with FreeMarker; the transaction is available as `record`) " +
    "against one transaction and writes the PDF to a file on the gateway host. Read-only: nothing is saved in NetSuite. " +
    "NetSuite refuses templates whose rendered markup loads images, fonts or stylesheets from outside NetSuite. " +
    "Returns the file path, size in bytes, page count and sha256, never the PDF itself.",
  writes: false,
  input: z.object({
    recordType: z.enum(PREVIEW_RECORD_TYPES).describe("Transaction type to render against"),
    recordId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe("Internal id of the transaction"),
    templateXml: z
      .string()
      .min(1)
      .max(MAX_TEMPLATE_CHARS)
      .describe("The draft template: <?xml?>, optional BFO DOCTYPE, then a <pdf> (or <pdfset>) root"),
  }),
  async handler({ recordType, recordId, templateXml }, ctx) {
    if (!PDF_ROOT.test(templateXml)) {
      throw new ToolInputError("templateXml must be an Advanced PDF/HTML template with a <pdf> (or <pdfset>) root element");
    }
    let response: PreviewResponse;
    try {
      response = await callRestlet<PreviewResponse>(ctx.ns, {
        ...RESTLET,
        body: { action: "preview", recordType, recordId, templateXml },
      });
    } catch (error) {
      if (error instanceof NsHttpError) throw previewError(error, recordType, recordId);
      throw error;
    }
    const pdf = typeof response?.base64 === "string" ? Buffer.from(response.base64, "base64") : undefined;
    if (!pdf || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new Error("The PDF preview RESTlet returned no PDF");
    }
    const dir = exportDir();
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.(\d+)Z$/, "$1Z");
    // Our own name, not the RESTlet's fileName: only the validated type and id go into the path.
    const file = path.join(dir, `pdf-preview-${recordType}-${recordId}-${stamp}.pdf`);
    await writeNew(file, pdf);
    return {
      file,
      bytes: pdf.length,
      pages: pdfPageCount(pdf) ?? null,
      sha256: createHash("sha256").update(pdf).digest("hex"),
      recordType,
      recordId,
      remainingUsage: typeof response.remainingUsage === "number" ? response.remainingUsage : null,
      next: "Open the file to check the layout. Nothing changed in NetSuite; the template ships through a pull request and the approved deploy.",
    };
  },
});

export const pdfTemplatesTools = [nsPdfPreview] as unknown as ToolDef[];
