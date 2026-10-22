# custom-fields changelog

## 0.1.0 - unreleased

- New skill (Phase 3, shipped disabled).
  - `ns_field_plan` validates a body, entity or item field spec with `packages/sdf-gen` and returns its SDF XML. It checks the script ID account-wide with SuiteQL (`transaction`, `item`, or each entity table) and the target record types' metadata for label clashes. It reports `exists`/`absent`/`unchecked` per table, and gives a warning for mandatory fields.
  - `ns_field_generate` writes the field to `netsuite/src/Objects/fields/` and adds the manifest features it needs. It never calls NetSuite to create anything (ADR 0002).
  - `ns_field_generate` refuses: a script ID found in NetSuite but not in the project; an ID it could not check on some table, unless `acceptUnchecked`; an overwrite without `replace`; and writes through symbolic links. Its writes are audited.
- Evals first: 8 tool cases (all passing against the demo account) and 3 agent cases; 6 should-route and 4 should-not-route trigger prompts.
- Changed during review (SuiteCloud acceptance loop, attempt 2): the script ID check moved from record metadata, which only lists fields applied to that record type, to the SuiteQL probe.
