const { McpServer } = require('@modelcontextprotocol/server');
const { registerRelayTools } = require('./tools');
const { registerRelayResources } = require('./resources');
const { version } = require('../package.json');

const INSTRUCTIONS = [
  'Relay turns GitHub pushes into plain-English email digests for a non-technical client.',
  'Each repository (owner/repo) is mapped to one client.',
  'Use preview_digest to check wording before anything is sent, and confirm with the user before',
  'calling send_test_digest or resend_digest, because those send real email.',
].join(' ');

// One fully registered Relay MCP server for one installation, independent
// of transport. `svc` comes from lib/service.js. The stdio entrypoint
// builds one at startup; the HTTP endpoint builds one per request.
function createRelayMcpServer(svc) {
  const server = new McpServer({ name: 'relay', version }, { instructions: INSTRUCTIONS });
  registerRelayTools(server, svc);
  registerRelayResources(server, svc);
  return server;
}

module.exports = { createRelayMcpServer };