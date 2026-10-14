# ADR 005: Relay runs its own OAuth authorization server for /mcp

## Status
Accepted

## Context
The MCP authorization spec (2026-07-28) makes an HTTP MCP server an OAuth
2.1 resource server. Clients discover the authorization server from
Protected Resource Metadata (RFC 9728). They identify themselves with Client
ID Metadata Documents, or with Dynamic Client Registration as a fallback.
They use PKCE and send a `resource` parameter (RFC 8707), and the server must
accept only tokens issued for its own URL.

GitHub's OAuth can't serve as that authorization server. It doesn't issue
audience-bound tokens for Relay, and it doesn't support client metadata
documents or dynamic registration for third-party clients. Passing GitHub
tokens through to Relay is also explicitly disallowed.

## Options
1. A managed identity provider with MCP support, using GitHub as a social
   login. Less code, but another vendor and less to learn.
2. A minimal authorization server inside Relay that uses GitHub only for the
   sign-in step.

## Decision
Option 2. `routes/oauth.js` and `lib/oauth/` implement:

- RFC 8414 metadata and RFC 9728 protected resource metadata (served via the
  MCP SDK's `mcpAuthMetadataRouter`)
- the authorization code flow with mandatory PKCE S256, an RFC 9207 `iss`
  parameter on every response, a consent screen with CSRF protection, and a
  CSP that only allows the client's own redirect
- Client ID Metadata Documents (HTTPS, public hosts only, size and time
  limits) and Dynamic Client Registration for public clients
- one-hour HS256 access tokens whose `aud` is `PUBLIC_URL/mcp`, and 30-day
  refresh tokens that rotate on use; codes and refresh tokens are stored only
  as SHA-256 hashes
- scopes `relay:read`, `relay:write` and `relay:send`, enforced per tool,
  with `insufficient_scope` challenges so clients can step up

## Consequences
- Tested end to end with the official MCP SDK client (`tests/mcp-http.test.js`).
- Security-sensitive code is now Relay's responsibility. Keep it small, keep
  the tests, and revisit Option 1 if requirements grow (token revocation
  UI, organization policies, audit logs).
- The CIMD fetcher blocks IP-literal and local hostnames but does not yet
  resolve DNS to refuse private addresses; do that before a public launch.
