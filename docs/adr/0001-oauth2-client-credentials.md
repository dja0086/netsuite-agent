# ADR 0001: OAuth 2.0 client credentials, no token-based authentication

**Status:** accepted · 2026-10-18

## Decision

The gateway and CI authenticate with OAuth 2.0 client credentials: a JWT client assertion signed with a certificate's private key (PS256 by default), exchanged for a short-lived access token.

## Why

- NetSuite ends support for new token-based authentication (TBA) integrations at release 2027.1. New builds must use OAuth 2.0.
- No long-lived token secret exists to leak; the private key never leaves the secrets backend, and access tokens expire.
- Certificates can be rotated without changing code (`NS_CERT_ID`).

## Consequences

- The private key is read at runtime from a secrets backend. The local `file` backend refuses keys inside the repo.
- A user-facing (authorization code) flow, if added later, must use PKCE.
