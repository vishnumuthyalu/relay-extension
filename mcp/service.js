const {
  openDb, upsertClient, getClient, listClients, deleteClient, listDigests, getDigest,
} = require('../lib/db');
const { createPipeline } = require('../lib/pipeline');

// Raised for problems the caller can fix (unknown repo, missing digest).
// Tools turn these into isError results instead of protocol errors.
class RelayError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RelayError';
  }
}

function toMapping(row) {
  return { repo: row.repo, clientName: row.client_name, clientEmail: row.client_email, updatedAt: row.updated_at };
}

// Everything the MCP tools and resources can do, in one place. The tools
// only ever talk to this interface, so Phase 4 can swap in a version
// scoped to one tenant without touching mcp/tools.js.
function createLocalService({ db = openDb(), pipeline = createPipeline() } = {}) {
  function requireClient(repo) {
    const client = getClient(db, repo);
    if (!client) throw new RelayError(`No client is mapped to ${repo}. Use set_client_mapping first.`);
    return client;
  }

  return {
    listMappings() {
      return listClients(db).map(toMapping);
    },

    setMapping({ repo, clientName, clientEmail }) {
      return toMapping(upsertClient(db, { repo, clientName, clientEmail }));
    },

    removeMapping({ repo }) {
      return { repo, removed: deleteClient(db, repo) };
    },

    async previewDigest({ repo, commits }) {
      return pipeline.previewDigest({ repo, commits });
    },

    async sendTestDigest({ repo }) {
      const { recipient } = await pipeline.sendTestDigest({ repo, client: requireClient(repo) });
      return { repo, sentTo: recipient };
    },

    listDigests({ repo, limit }) {
      return listDigests(db, { repo, limit });
    },

    getDigest({ deliveryId }) {
      const digest = getDigest(db, deliveryId);
      if (!digest) throw new RelayError(`No digest found for delivery ${deliveryId}.`);
      return digest;
    },

    async resendDigest({ deliveryId }) {
      const digest = this.getDigest({ deliveryId });
      const { recipient } = await pipeline.resendDigest({ digest, client: requireClient(digest.repo) });
      return { deliveryId, sentTo: recipient };
    },
  };
}

module.exports = { createLocalService, RelayError };