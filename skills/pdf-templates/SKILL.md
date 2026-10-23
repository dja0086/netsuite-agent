---
name: pdf-templates
description: Draft and preview NetSuite Advanced PDF/HTML templates (invoice, sales order, estimate, credit memo, purchase order and vendor bill printouts) by rendering a draft against a real transaction into a local PDF file. Use for "change the invoice PDF", "add the PO number to the printout", "preview this template on invoice 148". Writes an agreed template into the SuiteCloud project for a PR; never saves a template in NetSuite. Not for adding fields (custom-fields), reading transaction data (data-explorer) or exporting reports (reports).
version: 0.2.0
owner: "@dja0086"
# Tools this skill may call. Each must exist in apps/mcp-gateway/src/tools/ (see pdf-templates.ts, pdf-template-generate.ts).
tools: [ns_pdf_preview, ns_pdf_template_generate]
writes: false
# New skills ship disabled. Set to true only when the acceptance table passes (see docs/skill-lifecycle.md).
enabled: false
governance_budget:
  max_calls_per_invocation: 10
  max_concurrency: 2
---

# PDF templates

Helps a user change how a transaction prints. The agent drafts an Advanced PDF/HTML template (BFO XML with FreeMarker) and `ns_pdf_preview` renders it against one real transaction through the preview RESTlet (`customscript_ns_agent_pdf_rl`). The RESTlet renders and returns the PDF; it saves nothing in NetSuite. The gateway writes the PDF to the export folder on the gateway host (`NS_AGENT_EXPORT_DIR`, default `exports/`) and returns its path, size, page count and sha256, never the PDF contents. `ns_pdf_template_generate` then writes the agreed draft into the SuiteCloud project (`netsuite/src/Objects/templates/`) as an `advancedpdftemplate` object and its `.template.xml`, and adds the manifest features it needs; it calls nothing in NetSuite and never marks the template preferred.

## When to use

- A user wants a printout of an invoice, sales order, estimate, credit memo, purchase order or vendor bill to look different: a field added or moved, a new layout, a logo.
- A user has a template draft and wants to see it rendered on a real record.

Hand off instead when: the field the layout needs does not exist yet (custom-fields), the user asks what a field holds or which records match (data-explorer), the user wants a tabular export (reports), or asks how a template gets approved or rolled back (change-control).

## How to work

1. **Find a record to render.** Ask which transaction to preview on, or find a recent one of the right type with data-explorer (`ns_suiteql`). Only the six types above can be rendered. Note this account's renamed records: Customers = Clients, Sales Order = Master Contract, Bills = Vendor Invoices.
2. **Draft the template.** Start from `<?xml version="1.0"?>`, the BFO DOCTYPE (`<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">`) and a `<pdf>` root with `<head>` and `<body>`. The transaction is `record`: body fields as `${record.tranid}`, `${record.otherrefnum}`, lines with `<#list record.item as line>`. Use `ns_record_describe` for field ids instead of guessing. Escape user text; never put record data into an address.
3. **Only NetSuite-hosted resources.** Images, fonts and stylesheets must be NetSuite-hosted: relative paths or `netsuite.com` addresses (a File Cabinet file's URL), and fonts via `${nsfont.*}`. The RESTlet renders the FreeMarker first and refuses the preview if the rendered markup loads anything from another host, uses another scheme, a CSS `@import` or an entity declaration. If the user's logo is elsewhere, ask them to upload it to the File Cabinet and use its NetSuite URL.
4. **Preview.** Call `ns_pdf_preview` with `recordType`, `recordId` and the full `templateXml`. Report the file path, page count and size, and ask the user to open the file. On an error, read it: a template error means fix the FreeMarker or XML and preview again; "does not exist" means pick another record.
5. **Iterate, then agree.** Change the draft as the user asks and preview again. When the user is happy, confirm the names: a `purpose` in lowercase snake_case of at most 40 characters (`standard` gives `custtmpl_nsagent_invoice_standard`, ns-conventions) and a `title` such as `NS Agent - Invoice`.
6. **Generate.** Call `ns_pdf_template_generate` with `record`, `purpose`, `title` and exactly the previewed source. Invoice, sales order, estimate, credit memo and purchase order only (vendor bills can be previewed, not generated yet). If it refuses for the lint (an outside address, FreeMarker inside a `src`/`href`/`url()`, an include, `?eval`/`?interpret`/`?new`), explain why and propose the NetSuite-hosted alternative; never hide or encode the address. Report `written`, `manifestFeaturesAdded`, `sourceSha256` and the `review` lists (resource values and assigned variables). To change a template this project owns, generate again with `replace: true`, only when the user asked for that change.
7. **Hand over to change control.** The files are on disk, not in NetSuite. The next step is a pull request (`ns_change_open_pr`, once released and the user agrees), review, then the approved deploy (sandbox stage, then production stage). Removing a template needs a revert plus a NetSuite admin deleting it in the UI, since SDF deploys never delete objects.

## Approval and safety

`ns_pdf_preview` is read-only in NetSuite: it loads one transaction the integration role can already view and renders it. No approval is needed. The rendered-resource check runs inside NetSuite before the PDF is made, so a refused template fetches nothing. The PDF can contain customer data: it stays in the git-ignored export folder on the gateway host; do not paste its contents into the chat or anywhere else.

`ns_pdf_template_generate` writes only inside the SDF project folder (`NS_AGENT_SDF_DIR`, default `netsuite/src`), refuses a source that fails the template lint before writing anything, refuses to overwrite a template file unless `replace` is true, never writes through a symbolic link, and is recorded in the gateway audit log. No gateway approval is needed: nothing reaches NetSuite without the PR and the approved deploy.

Neither the preview nor the lint is the security control for a template that ships: PR review is (change-control). A reviewer reads every address and assignment in the template before it is merged.

## Do not

- Do not save, update or attach a template in NetSuite, or suggest pasting it into the NetSuite UI as a workaround.
- Do not load images, fonts or stylesheets from outside NetSuite, and do not try to get round the check (for example by building an address in FreeMarker).
- Do not claim a previewed or generated template is live, or mark one preferred.
- Do not generate before the user agreed the draft.
- Do not preview on many records to read their data; use data-explorer for data questions.
