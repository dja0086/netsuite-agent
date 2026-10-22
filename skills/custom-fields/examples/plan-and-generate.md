# Example: plan, agree, generate (demo account output)

**User:** Add a checkbox called Rush Order to sales orders and invoices.

**Agent:** calls `ns_field_plan` with `kind: body, name: rush, label: Rush order, type: CHECKBOX, appliesTo: [sale]`.

**Agent:** The field would be `custbody_nsagent_rush`, a checkbox on sales transactions (sales orders and invoices both count as `sale`). I checked sales orders and invoices: no field with that script ID or label exists, and it needs no extra manifest features. Shall I write it into the SuiteCloud project?

**User:** Yes.

**Agent:** calls `ns_field_generate` with the same arguments.

**Agent:** Written `Objects/fields/custbody_nsagent_rush.xml`. Nothing has changed in NetSuite yet: the next step is a pull request, then the approved deploy (sandbox stage, then production stage). The field appears in NetSuite only after the production stage is approved.
