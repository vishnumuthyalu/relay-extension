# Relay for VS Code

[Relay](https://github.com/vishnumuthyalu/relay-extension) turns every push to your main branch into a short, plain-English email for your client. This extension connects VS Code to your Relay server, so Copilot agent mode can manage Relay for you:

- "Map acme/website to Jane Doe at jane@acme.com."
- "Preview the digest Jane would get for these commits."
- "What digests went out this week?"

## Setup

1. Install the Relay GitHub App on your repositories: run **Relay: Install GitHub App**.
2. The extension connects to the hosted Relay (`https://relay-vishnu.fly.dev`) by default. If you run your own Relay server, set **relay.backendUrl** in Settings to its URL.
3. Open Copilot Chat in agent mode. Relay's tools appear in the tools list. The first time one runs, VS Code opens your browser so you can sign in with GitHub and approve access.

The extension registers Relay's MCP server (`<backendUrl>/mcp`) with VS Code. It stores no tokens: VS Code handles the OAuth sign-in.

## Commands

| Command | What it does |
|---------|--------------|
| Relay: Open Dashboard | Opens Relay's web dashboard |
| Relay: Install GitHub App | Opens the GitHub App install page |

## Other editors

Relay works in any MCP client with the same URL. See [docs/mcp.md](https://github.com/vishnumuthyalu/relay-extension/blob/main/docs/mcp.md) for Cursor, Windsurf, Claude Code and Claude Desktop.