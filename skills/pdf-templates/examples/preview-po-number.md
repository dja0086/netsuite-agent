# Example: draft a layout and preview it (demo account output)

**User:** Change the invoice PDF so it shows the PO number under the invoice number, and show me how it looks on invoice 148.

**Agent:** calls `ns_record_describe` for `invoice` to confirm the PO number field is `otherrefnum`, then calls `ns_pdf_preview` with `recordType: invoice`, `recordId: 148` and this draft:

```xml
<?xml version="1.0"?>
<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">
<pdf>
  <head><style>h1 { font-size: 16pt; } .po { color: #555555; }</style></head>
  <body size="Letter">
    <h1>Invoice ${record.tranid}</h1>
    <p class="po">PO number: ${record.otherrefnum!""}</p>
    <p>${record.entity} · ${record.trandate}</p>
  </body>
</pdf>
```

**Agent:** The preview is at `exports/pdf-preview-invoice-148-20261023T104512345Z.pdf` (1 page, 3.8 KB). Open it to check the layout. Nothing changed in NetSuite: the preview renders the draft and saves nothing. When you are happy with it, the template goes into the SuiteCloud project and reaches NetSuite through a pull request and the approved deploy.
