#!/usr/bin/env node
// Relay MCP server over stdio, for running against your own Relay
// database from an MCP client on this machine (Claude Code, Claude
// Desktop, VS Code, Cursor). It acts for one installation, set by
// RELAY_INSTALLATION_ID. Hosted users connect to /mcp instead.
//
// stdout carries the MCP protocol, so nothing else may write to it.
// Everything human-readable goes to stderr.
const path = require('path');

// MCP clients start this process from their own working directory, so
// load .env from the repo root explicitly. quiet: true stops dotenv from
// printing its banner to stdout, which would corrupt the protocol stream.
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { StdioServerTransport } = require('@modelcontextprotocol/server/stdio');
const { loadConfig, REQUIRED_FOR_MCP_STDIO } = require('../lib/config');
const { createPool } = require('../lib/db/pool');
const { getInstallation } = require('../lib/db');
const { createLinks } = require('../lib/links');
const { createPipeline } = require('../lib/pipeline');
const { createRelayMcpServer, forInstallation } = require('./server');

async function main() {
  const config = loadConfig(process.env, { required: REQUIRED_FOR_MCP_STDIO });
  const installationId = Number(process.env.RELAY_INSTALLATION_ID);
  if (!Number.isSafeInteger(installationId)) {
    throw new Error('Set RELAY_INSTALLATION_ID to the GitHub App installation this server acts for.');
  }

  const pool = createPool({ connectionString: config.databaseUrl, max: 2 });
  const installation = await getInstallation(pool, installationId);
  if (!installation) throw new Error(`Installation ${installationId} is not in the Relay database.`);

  const links = createLinks({ secret: config.sessionSecret, publicUrl: config.publicUrl });
  const pipeline = createPipeline({ config, links });
  const server = createRelayMcpServer(forInstallation({ pool, pipeline, config, installation }));
  await server.connect(new StdioServerTransport());
  console.error(`relay-mcp: ready on stdio for ${installation.account_login} (${installationId})`);
}

main().catch((err) => {
  console.error(`relay-mcp: ${err.message}`);
  process.exit(1);
});
