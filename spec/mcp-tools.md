# Relay MCP tools

The contract for Relay's MCP server. Every tool acts for one GitHub App
installation. `tests/mcp.test.js` checks that the server registers exactly
the tools in this table, so update both together.

| Tool | Input | Output (`structuredContent`) | Annotations |
|------|-------|------------------------------|-------------|
| `list_client_mappings` | none | `{ mappings: [{ repo, clientName, clientEmail, branch, status, updatedAt }] }` | read-only |
| `set_client_mapping` | `repo`, `clientName`, `clientEmail`, `branch?` | mapping + `confirmationSent` | idempotent, open-world (sends a confirmation email to a new address) |
| `remove_client_mapping` | `repo` | `{ repo, removed }` | destructive, idempotent |
| `preview_digest` | `repo`, `commits[]` (`message`, `author?`), 1–200 | `{ headline, summary, highlights, risk_notes }` | read-only, open-world (calls Claude) |
| `send_test_digest` | `repo` | `{ repo, sentTo }` | open-world (sends email; confirmed clients only) |
| `list_recent_digests` | `repo?`, `limit` 1–50 (default 10) | `{ digests: [{ deliveryId, repo, recipient, headline, commitCount, sentAt }] }` | read-only |
| `resend_digest` | `deliveryId` | `{ deliveryId, sentTo }` | open-world (sends email; confirmed clients only) |

`repo` is always `owner/repo`. A mapping's `status` is `pending` until the
client clicks the confirmation email, then `active`, or `unsubscribed`.
Problems the caller can fix (an unmapped repo, an unconfirmed client, an
unknown delivery ID, an unusable Claude reply) come back as a tool result
with `isError: true` and a message saying what to do next.

## Resources

| URI | Contents |
|-----|----------|
| `relay://clients` | All client mappings (JSON) |
| `relay://digests/{deliveryId}` | One sent digest with its full summary (JSON); the 50 most recent are listed |
| `relay://schema/summary` | `spec/summary.schema.json` |