# change-control changelog

## 0.2.0 - 2026-10-23

- New tool `ns_change_open_pr` (Phase 3), shipped disabled through the new `disabled_tools` manifest field: platform skills are always served, so listing it only in `tools` would have released it.
  - Commits only the files of the given nsagent fields and templates, plus `manifest.xml`, onto a new `nsagent/` branch built from `origin/main` in a private index (the working tree and current branch stay untouched). Pushes it and opens the PR with the local gh login (owner decision).
  - Refuses: an SDF project that is not `netsuite/src` of a checkout; an origin fetch or push URL other than `dja0086/netsuite-agent`; a gh account other than `dja0086`; any other change in the working tree; deleted, renamed or missing object files; a `manifest.xml` on HEAD that differs from `origin/main`; and a change that is already on `origin/main`.
  - The PR body lists the objects, the new manifest features and the reviewer checklist from step 3: for templates, every resource value and assigned variable (sdf-gen `templateReviewPoints`).
- "The path every change takes" and "What to tell the user today" name the tool. Evals: 3 tool cases (all refusals; tool evals never push) and 1 agent case.

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
