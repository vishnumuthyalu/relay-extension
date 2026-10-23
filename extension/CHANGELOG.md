# Changelog

## 1.0.0

- Registers Relay's remote MCP server with VS Code, so Copilot agent mode can use Relay's tools. Sign-in is OAuth, handled by VS Code.
- New commands: **Relay: Open Dashboard** and **Relay: Install GitHub App**.
- Removed the personal-access-token webhook setup and all stored secrets. Relay is now a GitHub App.

## 0.1.0

- First version: register a repository webhook with a personal access token, map a repository to a client, and send a test digest.