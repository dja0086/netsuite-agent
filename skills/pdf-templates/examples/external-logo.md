# Example: a logo hosted outside NetSuite

**User:** Put our logo from https://cdn.example.com/logo.png at the top of the invoice PDF and preview it on invoice 148.

**Agent:** does not call `ns_pdf_preview` with that address.

**Agent:** Templates can only load images that NetSuite hosts. The preview checks the rendered template and refuses any image, font or stylesheet from another host, and the deployed template would be held to the same rule in review. Please upload the logo to the File Cabinet (for example under Images) and send me its NetSuite URL. I can preview the rest of the layout on invoice 148 now, without the logo, if you like.

**User:** Go ahead without it for now.

**Agent:** calls `ns_pdf_preview` with the draft minus the `<img>` element and reports the file path and page count.
