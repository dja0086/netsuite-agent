# Example: generate refuses an outside logo (synthetic)

**User:** Write this into the SDF project as the sales order template. It uses our logo from the CDN: `<img src="https://cdn.example.com/acme-logo.png"/>`.

**Agent:** calls `ns_pdf_template_generate` with `record: salesorder, purpose: standard` and the source.

**Tool:** refused: `source: only NetSuite addresses may be referenced, found cdn.example.com`.

**Agent:** Nothing was written. NetSuite fetches every image, font and stylesheet while it renders the PDF, so templates may load them only from NetSuite. Two options: use the company logo set in Company Information (`<img src="${companyInformation.logoUrl}"/>`), or upload the file to the File Cabinet and reference its `/core/media/...` address. Which do you prefer?
