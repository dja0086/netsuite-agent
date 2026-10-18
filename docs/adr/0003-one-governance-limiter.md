# ADR 0003: One governance limiter in front of every NetSuite call

**Status:** accepted · 2026-10-18

## Decision

All outbound NetSuite traffic goes through `GovernanceLimiter` in `packages/ns-client`: a concurrency cap (`NS_MAX_CONCURRENCY`) plus retries with exponential backoff and jitter for throttling responses only (HTTP 429, `SSS_REQUEST_LIMIT_EXCEEDED`, `CONCURRENCY_LIMIT_EXCEEDED`).

## Why

NetSuite governs by concurrent requests shared across SOAP, REST and RESTlets for the whole account. Pacing by requests per minute does not help; capping in-flight requests does, and leaves room for other integrations.

## Consequences

- Allocate a dedicated concurrency slice to this integration in Integration Governance and set `NS_MAX_CONCURRENCY` at or below it.
- Large reads use keyset paging (`suiteqlAll`); large writes move to NetSuite's CSV import queue (Phase 2/3).
