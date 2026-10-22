# Example: a label that already exists (demo account output)

**User:** Add a checkbox "Allow Letters to be Emailed" to sales orders.

**Agent:** calls `ns_field_plan` with `kind: body, name: letters_email, label: Allow Letters to be Emailed, type: CHECKBOX, appliesTo: [sale]`.

**Agent:** The script ID `custbody_nsagent_letters_email` is free, but sales orders and invoices already have a custom field with exactly that label: `custbody_3805_dunning_letters_toemail`, which comes from the dunning bundle. Two fields with the same label on one form confuse users. Do you want to use the existing field, or create a new one with a different label (for example "Email letters (NS Agent)")?

**User:** Use the existing one then.

**Agent:** Then no new field is needed. Nothing was written.
