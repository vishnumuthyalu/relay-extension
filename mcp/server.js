const { McpServer } = require('@modelcontextprotocol/server');
const db = require('../lib/db');
const { createRelayService, RelayError } = require('../lib/service');
const { registerRelayTools } = require('./tools');
const { registerRelayResources } = require('./resources');
const { version } = require('../package.json');

const INSTRUCTIONS = [
  'Relay turns GitHub pushes into plain-English email digests for a non-technical client.',
  'Each repository (owner/repo) is mapped to one client, who must confirm by email before digests start.',
  'Use preview_digest to check wording before anything is sent, and confirm with the user before',
  'calling send_test_digest or resend_digest, because those send real email.',
  'If the user manages several GitHub accounts, call list_accounts and pass account to the other tools.',
].join(' ');

const toAccount = (i) => ({ account: i.account_login, accountType: i.account_type, suspended: Boolean(i.suspended_at) });

// Chooses which installation a tool call acts on, from the installations
// `listInstallations()` returns: the named account, or the only one there is.
function accountResolver({ pool, pipeline, config, listInstallations, installUrl }) {
  return {
    async listAccounts() {
      return (await listInstallations()).map(toAccount);
    },
    async resolve(account) {
      const installations = await listInstallations();
      let installation;
      if (account) {
        installation = installations.find((i) => i.account_login.toLowerCase() === account.toLowerCase());
        if (!installation) {
          const names = installations.map((i) => i.account_login).join(', ') || 'none';
          throw new RelayError(`You can't manage "${account}" in Relay. Accounts you can manage: ${names}.`, 404);
        }
      } else if (installations.length === 1) {
        [installation] = installations;
      } else if (installations.length === 0) {
        throw new RelayError(`Relay isn't installed on any account you can manage yet. Install it at ${installUrl}`, 404);
      } else {
        const names = installations.map((i) => i.account_login).join(', ');
        throw new RelayError(`You manage several accounts (${names}). Pass account to choose one.`, 400);
      }
      return createRelayService({ pool, pipeline, config, installation });
    },
  };
}

// A Relay MCP server for one signed-in user (HTTP) or one installation
// (stdio). The same tools and resources serve both.
function createRelayMcpServer(relay) {
  const server = new McpServer({ name: 'relay', version }, { instructions: INSTRUCTIONS });
  registerRelayTools(server, relay);
  registerRelayResources(server, relay);
  return server;
}

// Remote /mcp: everything the GitHub user may manage.
function forUser({ pool, pipeline, config, githubUserId, installUrl }) {
  return accountResolver({
    pool, pipeline, config, installUrl,
    listInstallations: () => db.listUserInstallations(pool, githubUserId),
  });
}

// Local stdio: exactly one installation, fixed at startup.
function forInstallation({ pool, pipeline, config, installation }) {
  return accountResolver({
    pool, pipeline, config, installUrl: '',
    listInstallations: async () => [installation],
  });
}

module.exports = { createRelayMcpServer, forUser, forInstallation };
