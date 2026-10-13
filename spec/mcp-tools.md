# Relay MCP tools

The contract for Relay's MCP server. `tests/mcp.test.js` checks that the
server registers exactly the tools in this table, so update both together.

| Tool | Input | Output (`structuredContent`) | Annotations |
|------|-------|------------------------------|-------------|
| `list_client_mappings` | none | `{ mappings: [{ repo, clientName, clientEmail, updatedAt }] }` | read-only |
| `set_client_mapping` | `repo`, `clientName`, `clientEmail` | `{ repo, clientName, clientEmail, updatedAt }` | idempotent |
| `remove_client_mapping` | `repo` | `{ repo, removed }` | destructive, idempotent |
| `preview_digest` | `repo`, `commits[]` (`message`, `author?`), 1–200 | `{ headline, summary, highlights, risk_notes }` | read-only, open-world (calls Claude) |
| `send_test_digest` | `repo` | `{ repo, sentTo }` | open-world (sends email) |
| `list_recent_digests` | `repo?`, `limit` 1–50 (default 10) | `{ digests: [{ deliveryId, repo, recipient, headline, commitCount, sentAt }] }` | read-only |
| `resend_digest` | `deliveryId` | `{ deliveryId, sentTo }` | open-world (sends email) |

`repo` is always `owner/repo`. Problems the caller can fix (an unmapped
repo, an unknown delivery ID, an unusable Claude reply) come back as a
tool result with `isError: true` and a message saying what to do next.

## Resources

| URI | Contents |
|-----|----------|
| `relay://clients` | All client mappings (JSON) |
| `relay://digests/{deliveryId}` | One sent digest with its full summary (JSON); the 50 most recent are listed |
| `relay://schema/summary` | `spec/summary.schema.json` |