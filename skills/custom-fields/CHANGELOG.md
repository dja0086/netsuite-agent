# custom-fields changelog

## 0.1.0 - unreleased

- New skill (Phase 3, shipped disabled). `ns_field_plan` validates a body, entity or item field spec with `packages/sdf-gen`, returns its SDF XML and checks the account's record metadata for script ID and label clashes, reporting the record types it could not read. `ns_field_generate` writes the field to `netsuite/src/Objects/fields/` and adds the manifest features it needs; it never calls NetSuite to create anything (ADR 0002) and refuses to take over a script ID that exists in NetSuite but not in the project.
- Evals first: 6 tool cases (all passing against the demo account) and 3 agent cases; 6 should-route and 4 should-not-route trigger prompts.
