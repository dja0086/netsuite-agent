# pdf-templates changelog

## 0.2.0 - unreleased

- New tool `ns_pdf_template_generate` (Phase 3 PR 5, skill still disabled). It writes an agreed BFO + FreeMarker draft as an `advancedpdftemplate` object (`custtmpl_nsagent_<record>_<purpose>`) and its `.template.xml` under `netsuite/src/Objects/templates/` with `packages/sdf-gen`, and adds the manifest features it needs. It never calls NetSuite (ADR 0002) and never marks the template preferred.
  - It refuses sources that fail the sdf-gen template lint, overwrites without `replace`, and writes through symbolic links. It returns the source's sha256 and the resource values and assignments the PR reviewer must read (`templateReviewPoints`). Its writes are audited.
  - Invoice, sales order, estimate, credit memo and purchase order only: sdf-gen has no standard template mapping for vendor bills yet, so those can be previewed but not generated.
- "How to work" gains the generate step and the hand-over to `ns_change_open_pr` (change-control 0.2.0, not released yet).
- Evals first: 6 tool cases and 2 agent cases; 3 more should-route prompts and 1 more should-not-route prompt.

## 0.1.0 - unreleased

- New skill (Phase 3, shipped disabled).
  - `ns_pdf_preview` renders a draft Advanced PDF/HTML template against one invoice, sales order, estimate, credit memo, purchase order or vendor bill through the preview RESTlet (`customscript_ns_agent_pdf_rl`). It writes the PDF to `NS_AGENT_EXPORT_DIR` (default `exports/`, git-ignored) and returns the path, size, page count and sha256, never the PDF contents. Read-only in NetSuite.
  - Input is checked with the RESTlet's allow-list and limits (record type, positive integer id, template of at most 100,000 characters) and must have a `<pdf>` or `<pdfset>` root, so bad input never reaches NetSuite. The file name comes from the validated type and id, not the RESTlet's `fileName`, and is created exclusively without following symbolic links.
  - RESTlet and NetSuite errors are mapped to messages the agent can act on: the rendered-resource refusal, low usage units, a missing record, an id of another transaction type, an undeployed RESTlet, XML errors (`USER_ERROR`) and FreeMarker errors (NetSuite reports these as `UNEXPECTED_ERROR` with no detail).
- Evals first: 8 tool cases (all passing against the demo account) and 3 agent cases; 6 should-route and 4 should-not-route trigger prompts.
