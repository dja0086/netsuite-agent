# Example: tables the script ID check cannot read (demo account output)

**User:** We need an Account Manager field on customers and partners, picking an employee.

**Agent:** calls `ns_field_plan` with `kind: entity, name: account_manager, label: Account manager, type: SELECT, selectRecordType: "-4", appliesTo: [customer, partner]`.

**Agent:** The field would be `custentity_nsagent_account_manager`, a list of employees on customers and partners. The ID is unused on customers, vendors and contacts. I could not check employees, partners, projects, other names, generic resources, groups or project templates: the integration role cannot query those tables. If a field with this ID existed there, the deploy would overwrite it, so whoever reviews the pull request has to confirm it does not. I could not check partner labels either. Applying the field to partners also adds the CRM feature to the project manifest as required.

Do you want me to write it into the project on that basis?

**User:** Yes, I'll check partners when I review the PR.

**Agent:** calls `ns_field_generate` with the same arguments plus `acceptUnchecked: true`, and reports the files written.
