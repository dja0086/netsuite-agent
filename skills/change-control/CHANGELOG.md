# change-control changelog

## 0.1.4 - 2026-10-22

- Review step: for PDF templates, PR review is named as the security control, with what the reviewer checks (resource addresses, FreeMarker that builds addresses or shadows variables). The sdf-gen template check is a lint (SuiteCloud acceptance loop on #6). Description and evals unchanged.

## 0.1.3 - 2026-10-22

- Owner handle moved to @dja0086 (OWNERS, frontmatter, CODEOWNERS) after the repository moved to dja0086/netsuite-agent.
- "What to tell the user today" no longer says writes are disabled: it separates data changes (only through the approval-gated tools, ADRs 0004-0006) from configuration changes (SDF pull requests, tools still to come in Phase 3). Description and evals unchanged.

## 0.1.2 - 2026-10-21

- Eval cases `refuses-direct-edit` and `explains-rollback` no longer require a tool call (the right answers need none); the rubric still judges them. Agreed by the owner after the first agent-eval run (docs/agent-evals.md).

## 0.1.1 - unreleased (Phase 1)

- Owner set to @dja-cowboyallstar (was a [FILL] placeholder).

## 0.1.0 - unreleased (Phase 1)

- Process description only. `ns_change_open_pr` and deploy tooling land in Phase 3.
