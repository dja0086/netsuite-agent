# pdf-templates changelog

## 0.1.0 - unreleased

- New skill (Phase 3, shipped disabled).
  - `ns_pdf_preview` renders a draft Advanced PDF/HTML template against one invoice, sales order, estimate, credit memo, purchase order or vendor bill through the preview RESTlet (`customscript_ns_agent_pdf_rl`). It writes the PDF to `NS_AGENT_EXPORT_DIR` (default `exports/`, git-ignored) and returns the path, size, page count and sha256, never the PDF contents. Read-only in NetSuite.
  - Input is checked with the RESTlet's allow-list and limits (record type, positive integer id, template of at most 100,000 characters) and must have a `<pdf>` or `<pdfset>` root, so bad input never reaches NetSuite. The file name comes from the validated type and id, not the RESTlet's `fileName`, and is created exclusively without following symbolic links.
  - RESTlet and NetSuite errors are mapped to messages the agent can act on: the rendered-resource refusal, low usage units, a missing record, an id of another transaction type, an undeployed RESTlet, XML errors (`USER_ERROR`) and FreeMarker errors (NetSuite reports these as `UNEXPECTED_ERROR` with no detail).
- Evals first: 8 tool cases (all passing against the demo account) and 3 agent cases; 6 should-route and 4 should-not-route trigger prompts.
