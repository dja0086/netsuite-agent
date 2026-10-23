# Example: agree, generate, hand over (synthetic)

**User:** Finance signed off the invoice layout we previewed on invoice 4711. Save it as our standard invoice template.

**Agent:** The template would be `custtmpl_nsagent_invoice_standard`, titled "NS Agent - Invoice". It is never marked preferred, so nobody's default printout changes when it deploys. Shall I write it into the SuiteCloud project?

**User:** Yes.

**Agent:** calls `ns_pdf_template_generate` with `record: invoice, purpose: standard, title: NS Agent - Invoice` and the previewed source.

**Agent:** Written `Objects/templates/custtmpl_nsagent_invoice_standard.xml`, its `.template.xml` and `manifest.xml` (added the features `ADVANCEDPRINTING` and `ACCOUNTING`). The source's sha256 starts with `3f2a…`, matching the draft you previewed. The reviewer has one resource to read, `${nsfont.NotoSans_Regular}` (a NetSuite font), and no assignments. Nothing has changed in NetSuite: next comes a pull request, then the approved deploy (sandbox stage, then production stage).
