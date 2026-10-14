# ADR 002: Distribute Relay as a GitHub App, not per-repo webhooks

## Status
Accepted (supersedes the personal-access-token flow in the VS Code extension)

## Context
Relay originally asked each developer for a personal access token with
`admin:repo_hook` scope and created one webhook per repository from the
VS Code extension. That works for one person, but it doesn't scale to many
users: tokens live on developers' machines, every repo needs setup, and
access doesn't follow organization membership.

## Decision
Register Relay as a GitHub App. Users install it on an account or
organization and choose repositories. GitHub then sends every push for those
repositories to one webhook URL, with an `installation.id` that identifies
the tenant. "Sign in with GitHub" uses the same app's user authorization,
and Relay authorizes requests by which installations the user can access.

## Consequences
- No long-lived tokens are stored anywhere; the webhook secret lives only on
  the server.
- Each installation is a tenant, so the database is keyed by
  `installation_id` and uninstalling deletes that tenant's data.
- Relay must handle `installation` lifecycle events.
- The VS Code extension no longer creates webhooks; it only links to the
  install page and sign-in.