# Using Relay from an MCP client

Relay ships an MCP server, so you can manage client mappings, preview
digests and browse digest history by chatting with Claude Code, Claude
Desktop, VS Code (Copilot agent mode) or Cursor. The tools are listed in
[`spec/mcp-tools.md`](../spec/mcp-tools.md).

This page covers the **local** server, which talks to the SQLite database
on your machine over stdio.

## Prerequisites

- Node.js 22.5+
- `npm install` in the repo
- A `.env` in the repo root with `ANTHROPIC_API_KEY`, `RESEND_API_KEY` and
  `FROM_EMAIL` (the same file the backend uses). The server loads it from the
  repo root no matter which folder your editor starts it from.

Replace `/abs/path/to/relay-extension` below with the absolute path to your
clone.

## Claude Code

```bash
claude mcp add relay -- node --experimental-sqlite /abs/path/to/relay-extension/mcp/stdio.js
```

## VS Code

Create `.vscode/mcp.json` in any workspace:

```json
{
  "servers": {
    "relay": {
      "type": "stdio",
      "command": "node",
      "args": ["--experimental-sqlite", "/abs/path/to/relay-extension/mcp/stdio.js"]
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
      "args": ["--experimental-sqlite", "/abs/path/to/relay-extension/mcp/stdio.js"]
    }
  }
}
```

## Claude Desktop

Add the same `mcpServers` entry as Cursor to `claude_desktop_config.json`, then
restart Claude Desktop.

## Try it

- "Map acme/website to Jane Doe at jane@acme.com."
- "Preview the digest Jane would get for these commits: fix checkout rounding, add saved cards."
- "What digests went out this week?"

## Debugging

Run the server under the MCP Inspector to call tools by hand:

```bash
npx @modelcontextprotocol/inspector node --experimental-sqlite mcp/stdio.js
```

The server writes its logs to stderr only. Anything printed to stdout would
corrupt the protocol, so never add `console.log` to files under `mcp/`.