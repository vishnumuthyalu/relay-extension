# ADR 004: MCP is how Relay works in every editor

## Status
Accepted

## Context
Relay started as a VS Code extension. People also use Cursor, Windsurf,
JetBrains IDEs, Zed, Claude Code and Claude Desktop. Writing an extension
per editor means the same features several times over, each with its own
release process.

## Decision
Expose Relay's operations as an MCP server and treat it as the main
interface for developers:

- **Remote** (`https://<host>/mcp`, Streamable HTTP, OAuth): for everyone
  using the hosted Relay. One URL works in every MCP client.
- **Local** (`mcp/stdio.js`): for people running their own Relay against
  their own database.

Both serve the same tools and resources (`mcp/tools.js`, `mcp/resources.js`),
which call the same `RelayService` as the JSON API and the dashboard. The
VS Code extension becomes a thin convenience layer that registers the
remote server.

## Consequences
- New capabilities are built once, as a service method plus a tool.
- The remote endpoint is stateless, so it scales with the web process.
- A small web dashboard still exists for people who don't use an MCP client.
