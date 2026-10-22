# Example: a target the clash check cannot read (demo account output)

**User:** We need an Account Manager field on customers and partners, picking an employee.

**Agent:** calls `ns_field_plan` with `kind: entity, name: account_manager, label: Account manager, type: SELECT, selectRecordType: "-4", appliesTo: [customer, partner]`.

**Agent:** The field would be `custentity_nsagent_account_manager`, a list of employees on customers and partners. I checked customers: no clash. I could not check partners, because they are not in the integration role's metadata catalog; the deploy's server validation is the final check there. Applying the field to partners also adds the CRM feature to the project manifest as required. Shall I write it into the project?
