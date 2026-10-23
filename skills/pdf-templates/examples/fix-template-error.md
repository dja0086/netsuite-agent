# Example: fixing a template that does not render (demo account output)

**User:** Preview this purchase order template on PO 1203: `<pdf><body><p>${record.tranid}</p><p>${record.duedate}</body></pdf>`

**Agent:** calls `ns_pdf_preview` with `recordType: purchaseorder`, `recordId: 1203` and the template.

**Agent:** It did not render: `The template did not render: Error Parsing XML: The element type "p" must be terminated by the matching end-tag "</p>".` The second paragraph is not closed; I've added `</p>`. Previewing again.

**Agent:** calls `ns_pdf_preview` with the corrected template.

**Agent:** The preview is at `exports/pdf-preview-purchaseorder-1203-20261023T110233101Z.pdf` (1 page). Nothing changed in NetSuite.
