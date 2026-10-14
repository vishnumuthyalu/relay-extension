# Using Relay from an MCP client

Relay ships an MCP server, so you can manage client mappings, preview
digests and browse digest history by chatting with Claude Code, Claude
Desktop, VS Code (Copilot agent mode) or Cursor. The tools are listed in
[`spec/mcp-tools.md`](../spec/mcp-tools.md).

There are two ways to connect:

- **Remote** (most people): add `https://<your-relay-host>/mcp` to your
  client. The first time you use it, your browser opens to sign in with
  GitHub and approve the client. You can then manage every account where
  you can manage Relay.
- **Local**: run `mcp/stdio.js` against your own Relay database. It acts
  for one GitHub App installation.

## Remote server

| Client | How to add it |
|--------|---------------|
| Claude Code | `claude mcp add --transport http relay https://<host>/mcp` |
| VS Code | `.vscode/mcp.json` → `{ "servers": { "relay": { "type": "http", "url": "https://<host>/mcp" } } }` |
| Cursor / Windsurf | `{ "mcpServers": { "relay": { "url": "https://<host>/mcp" } } }` in their MCP config |
| Claude (web, desktop, mobile) | Add it as a custom connector with the same URL |

What happens on first use:

1. The client calls `/mcp` without a token and gets `401` with a
   `WWW-Authenticate` header pointing at
   `/.well-known/oauth-protected-resource/mcp`.
2. From there it finds Relay's authorization server, registers (or uses
   its client metadata URL), and opens `/oauth/authorize` in your browser.
3. You sign in with GitHub and click **Allow**. The client receives a
   one-hour token for `https://<host>/mcp` and a refresh token.

Scopes: `relay:read` (list, preview, history), `relay:write` (change
mappings) and `relay:send` (test and resend digests). If you manage several
GitHub accounts, ask Claude to run `list_accounts` first, or name the
account in your request.

For local development, run Relay at `http://localhost:3000`, and the MCP URL
is `http://localhost:3000/mcp`.

## Local server

The stdio server talks to your Relay Postgres database directly and acts for
one GitHub App installation. Use it when you run your own Relay.

### Prerequisites

- Node.js 22.12+
- `npm install` in the repo
- A `.env` in the repo root, the same file the backend uses, with
  `DATABASE_URL`, `PUBLIC_URL`, `SESSION_SECRET`, `RESEND_API_KEY`,
  `FROM_EMAIL` and `ANTHROPIC_API_KEY`, plus `RELAY_INSTALLATION_ID`: the
  installation to act for (`GET /api/me` lists yours). The server loads the
  file from the repo root no matter which folder your editor starts it from.

Replace `/abs/path/to/relay-extension` below with the absolute path to your
clone.

### Claude Code

```bash
claude mcp add relay -- node /abs/path/to/relay-extension/mcp/stdio.js
```

### VS Code

Create `.vscode/mcp.json` in any workspace:

```json
{
  "servers": {
    "relay": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/relay-extension/mcp/stdio.js"]
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "relay": {
      "command": "node",
      "args": ["/abs/path/to/relay-extension/mcp/stdio.js"]
    }
  }
}
```

### Claude Desktop

Add the same `mcpServers` entry as Cursor to `claude_desktop_config.json`, then
restart Claude Desktop.

## Try it

- "Map acme/website to Jane Doe at jane@acme.com." (Jane gets a confirmation email.)
- "Preview the digest Jane would get for these commits: fix checkout rounding, add saved cards."
- "What digests went out this week?"

## Debugging

Run the stdio server under the MCP Inspector to call tools by hand. The
Inspector can also connect to `http://localhost:3000/mcp` and walk through
the OAuth flow:

```bash
npx @modelcontextprotocol/inspector node mcp/stdio.js
```

The server writes its logs to stderr only. Anything printed to stdout would
corrupt the protocol, so never add `console.log` to files under `mcp/`.
