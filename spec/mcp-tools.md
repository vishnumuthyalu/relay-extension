# Relay MCP tools

The contract for Relay's MCP server, served over stdio (`mcp/stdio.js`, one
installation) and over Streamable HTTP at `/mcp` (every installation the
signed-in user can manage). `tests/mcp.test.js` checks that the server
registers exactly the tools in this table, so update both together.

Every tool except `list_accounts` takes an optional `account`: the GitHub
user or organization to act for. It's only needed when the caller can
manage more than one.

| Tool | Input | Output (`structuredContent`) | Annotations | Scope (HTTP) |
|------|-------|------------------------------|-------------|--------------|
| `list_accounts` | none | `{ accounts: [{ account, accountType, suspended }] }` | read-only | `relay:read` |
| `list_client_mappings` | none | `{ mappings: [{ repo, clientName, clientEmail, branch, status, updatedAt }] }` | read-only | `relay:read` |
| `set_client_mapping` | `repo`, `clientName`, `clientEmail`, `branch?` | mapping + `confirmationSent` | idempotent, open-world (sends a confirmation email to a new address) | `relay:write` |
| `remove_client_mapping` | `repo` | `{ repo, removed }` | destructive, idempotent | `relay:write` |
| `preview_digest` | `repo`, `commits[]` (`message`, `author?`), 1–200 | `{ headline, summary, highlights, risk_notes }` | read-only, open-world (calls Claude) | `relay:read` |
| `send_test_digest` | `repo` | `{ repo, sentTo }` | open-world (sends email; confirmed clients only) | `relay:send` |
| `list_recent_digests` | `repo?`, `limit` 1–50 (default 10) | `{ digests: [{ deliveryId, repo, recipient, headline, commitCount, sentAt }] }` | read-only | `relay:read` |
| `resend_digest` | `deliveryId` | `{ deliveryId, sentTo }` | open-world (sends email; confirmed clients only) | `relay:send` |

`repo` is always `owner/repo`. A mapping's `status` is `pending` until the
client clicks the confirmation email, then `active`, or `unsubscribed`.
Problems the caller can fix (an unmapped repo, an unconfirmed client, an
unknown delivery ID, an unusable Claude reply) come back as a tool result
with `isError: true` and a message saying what to do next.

## Resources

| URI | Contents |
|-----|----------|
| `relay://accounts/{account}/clients` | All client mappings for one account (JSON) |
| `relay://accounts/{account}/digests/{deliveryId}` | One sent digest with its full summary (JSON); the 20 most recent per account are listed |
| `relay://schema/summary` | `spec/summary.schema.json` |

## Scopes

Over HTTP, an access token carries some of `relay:read`, `relay:write` and
`relay:send`. Calling a tool without its scope returns `403` with
`WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`, so the
client can ask the user to grant it. Over stdio there is no token and no
scope check.
