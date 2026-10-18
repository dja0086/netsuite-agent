# ADR 0002: Account changes only through SDF and pull requests

**Status:** accepted · 2026-10-18

## Decision

The agent never changes NetSuite configuration live. Custom fields, PDF templates, saved CSV import maps, scripts and the integration role are SDF objects in `netsuite/`, merged by pull request and deployed by `deploy-sdf.yml` (sandbox, then production, each behind GitHub environment approvals).

## Why

Field and template changes affect every user and every downstream integration. Review, sandbox validation and one-step rollback (revert PR) matter more than speed.

## Consequences

- Skills that "create" fields or templates generate XML and open a PR; they never call NetSuite to create them.
- Data writes (saved searches, record imports) are a separate path: approval-gated tool calls, bound to the exact payload.
