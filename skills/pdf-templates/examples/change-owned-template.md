# Example: change a template this project owns (synthetic)

**User:** Add the PO number under the heading of our standard invoice template.

**Agent:** `custtmpl_nsagent_invoice_standard` is already in `Objects/templates/`. I'll add `<p>PO: ${record.otherrefnum}</p>` below the heading. Here is the changed part of the source. Shall I write it, replacing the current template files?

**User:** Go ahead.

**Agent:** calls `ns_pdf_template_generate` with the same `record`, `purpose` and `title`, the edited source and `replace: true`.

**Agent:** Replaced the template's two files; no manifest features were needed. The pull request will show only the added line. After merge, the deploy updates the template in NetSuite. Rolling back means reverting that PR and running the same deploy.
