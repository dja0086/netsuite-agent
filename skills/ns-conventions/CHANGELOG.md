# ns-conventions changelog

## 1.0.4 - 2026-10-22

- Name length rule corrected for custom fields (at most 21 characters after the prefix; SDF caps body and item field script IDs at 38 characters and entity fields at 40, prefix included, checked with `suitecloud project:validate`) and stated for PDF template purposes (40). Saved searches keep 30. Description and evals unchanged.

## 1.0.3 - 2026-10-22

- Owner handle moved to @dja0086 (OWNERS, frontmatter, CODEOWNERS) after the repository moved to dja0086/netsuite-agent.

## 1.0.2 - 2026-10-21

- Eval cases `names-saved-search` and `refuses-redaction-workaround` no longer require a tool call; `refuses-redaction-workaround` still forbids `ns_record_get`. Agreed by the owner (docs/agent-evals.md).

## 1.0.1 - unreleased (Phase 1)

- Owner set to @dja-cowboyallstar (was a [FILL] placeholder).

## 1.0.0 - unreleased (Phase 1)

- Naming table, SuiteQL idioms, governance and data-handling rules.
