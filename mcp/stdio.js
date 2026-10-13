#!/usr/bin/env node
// Relay MCP server over stdio, for MCP clients on this machine
// (Claude Code, Claude Desktop, VS Code, Cursor).
//
// stdout carries the MCP protocol, so nothing else may write to it.
// Everything human-readable goes to stderr.
const path = require('path');

// MCP clients start this process from their own working directory, so
// load .env from the repo root explicitly. quiet: true stops dotenv from
// printing its banner to stdout, which would corrupt the protocol stream.
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { StdioServerTransport } = require('@modelcontextprotocol/server/stdio');
const { createRelayMcpServer } = require('./server');
const { createLocalService } = require('./service');

async function main() {
  const missing = ['ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'FROM_EMAIL'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`relay-mcp: missing env vars ${missing.join(', ')}; preview and send tools will fail.`);
  }

  const server = createRelayMcpServer(createLocalService());
  await server.connect(new StdioServerTransport());
  console.error('relay-mcp: ready on stdio');
}

main().catch((err) => {
  console.error('relay-mcp: failed to start', err);
  process.exit(1);
});