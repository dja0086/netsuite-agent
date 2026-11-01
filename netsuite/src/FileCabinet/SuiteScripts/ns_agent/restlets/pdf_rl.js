/**
 * PDF preview RESTlet for the ns-agent gateway (pdf-templates skill).
 * Actions:
 *   preview { recordType, recordId, templateXml } -> renders a draft Advanced PDF/HTML template against one
 *           transaction and returns the PDF as base64. Read-only: it never saves a file or a template.
 *
 * The draft comes from an agent, so it is untrusted: FreeMarker can build any address at render time, and BFO fetches
 * images, fonts and stylesheets while making the PDF. The template is therefore rendered to markup first, the
 * rendered resource addresses are checked (lib/resource_scan.js: NetSuite-hosted only), and only then is the markup
 * turned into a PDF. A refused template fetches nothing.
 *
 * Deployed only to the ns-agent integration role (see customscript_ns_agent_pdf_rl.xml).
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
define(['N/render', 'N/record', 'N/error', '../lib/governance', '../lib/resource_scan'], (render, record, error, governance, resourceScan) => {
  // Only transaction types the integration role can already View (customrole_ns_agent.xml).
  const RECORD_TYPES = new Set(['invoice', 'salesorder', 'estimate', 'creditmemo', 'purchaseorder', 'vendorbill']);
  const MAX_TEMPLATE_CHARS = 100000;
  const RECORD_ID = /^[1-9][0-9]{0,15}$/;

  const fail = (message) => {
    throw error.create({ name: 'NS_AGENT_BAD_INPUT', message, notifyOff: true });
  };

  const recordType = (value) => {
    if (typeof value !== 'string' || !RECORD_TYPES.has(value)) {
      fail(`recordType must be one of ${[...RECORD_TYPES].join(', ')}, got ${JSON.stringify(value)}`);
    }
    return value;
  };

  const recordId = (value) => {
    const text = typeof value === 'number' ? String(value) : value;
    if (typeof text !== 'string' || !RECORD_ID.test(text) || !Number.isSafeInteger(Number(text))) {
      fail(`recordId must be a positive integer, got ${JSON.stringify(value)}`);
    }
    return Number(text);
  };

  const templateXml = (value) => {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_TEMPLATE_CHARS) {
      fail(`templateXml must be a non-empty string of at most ${MAX_TEMPLATE_CHARS} characters`);
    }
    return value;
  };

  /** NetSuite's font folder, learned by rendering a fixed probe template; see lib/resource_scan.js. */
  const FONT_PROBE = '<?xml version="1.0"?>\n<pdf><body>${nsfont.NotoSans_Regular}</body></pdf>';
  const fontDirectory = () => {
    const probe = render.create();
    probe.templateContent = FONT_PROBE;
    return resourceScan.fontDirectoryFrom(probe.renderAsString());
  };

  const preview = (body) => {
    governance.requireUsage(100);
    const type = recordType(body.recordType);
    const id = recordId(body.recordId);
    const xml = templateXml(body.templateXml);
    const renderer = render.create();
    renderer.templateContent = xml; // draft from the agent; preview only, never saved
    renderer.addRecord({ templateName: 'record', record: record.load({ type, id }) });
    // FreeMarker only: no PDF yet, so nothing has been fetched.
    const markup = renderer.renderAsString();
    const issues = resourceScan.renderedResourceIssues(markup, { fontDirectory: fontDirectory() });
    if (issues.length > 0) {
      fail(`the rendered template loads resources from outside NetSuite or in a way that is not allowed: ${issues.join('; ')}`);
    }
    const pdf = render.xmlToPdf({ xmlString: markup });
    return { fileName: `${type}_${id}.pdf`, base64: pdf.getContents(), remainingUsage: governance.remainingUsage() };
  };

  const ACTIONS = { preview };

  const post = (body) => {
    governance.requireObject(body, 'request body');
    const handler = ACTIONS[body.action];
    if (!handler) throw error.create({ name: 'NS_AGENT_UNKNOWN_ACTION', message: `Unknown action: ${body.action}`, notifyOff: true });
    return handler(body);
  };

  return { post };
});
