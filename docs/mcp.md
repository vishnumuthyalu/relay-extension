# Using Relay from an MCP client

Relay ships an MCP server, so you can manage client mappings, preview
digests and browse digest history by chatting with Claude Code, Claude
Desktop, VS Code (Copilot agent mode) or Cursor. The tools are listed in
[`spec/mcp-tools.md`](../spec/mcp-tools.md).

This page covers the **local** stdio server, which talks to your Relay
Postgres database directly and acts for one GitHub App installation. It's
for running your own Relay. People using a hosted Relay connect to its
`/mcp` URL instead.

## Prerequisites

- Node.js 22.12+
- `npm install` in the repo
- A `.env` in the repo root, the same file the backend uses, with
  `DATABASE_URL`, `PUBLIC_URL`, `SESSION_SECRET`, `RESEND_API_KEY`,
  `FROM_EMAIL` and `ANTHROPIC_API_KEY`, plus `RELAY_INSTALLATION_ID`: the
  installation to act for (`GET /api/me` lists yours). The server loads the
  file from the repo root no matter which folder your editor starts it from.

Replace `/abs/path/to/relay-extension` below with the absolute path to your
clone.

## Claude Code

```bash
claude mcp add relay -- node /abs/path/to/relay-extension/mcp/stdio.js
```

## VS Code

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

## Cursor

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

## Claude Desktop

Add the same `mcpServers` entry as Cursor to `claude_desktop_config.json`, then
restart Claude Desktop.

## Try it

- "Map acme/website to Jane Doe at jane@acme.com." (Jane gets a confirmation email.)
- "Preview the digest Jane would get for these commits: fix checkout rounding, add saved cards."
- "What digests went out this week?"

## Debugging

Run the server under the MCP Inspector to call tools by hand:

```bash
npx @modelcontextprotocol/inspector node mcp/stdio.js
```

The server writes its logs to stderr only. Anything printed to stdout would
corrupt the protocol, so never add `console.log` to files under `mcp/`.