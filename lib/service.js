const db = require('./db');

// Raised for problems the caller can fix (unknown repo, client hasn't
// confirmed yet). The API maps these to 4xx; MCP tools return them as
// isError results the model can read and act on.
class RelayError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RelayError';
    this.status = status;
  }
}

// Everything one tenant can do, scoped to a single installation. The JSON
// API, the web dashboard and both MCP transports all call this, so the
// rules (confirmation, active-only sends, caps) live in one place.
function createRelayService({ pool, pipeline, config, installation }) {
  const installationId = installation.id;

  async function requireActiveMapping(repo) {
    const mapping = await db.getMapping(pool, installationId, repo);
    if (!mapping) throw new RelayError(`No client is mapped to ${repo}. Use set_client_mapping first.`, 404);
    if (mapping.status === 'pending') {
      throw new RelayError(`${mapping.clientEmail} hasn't confirmed updates for ${repo} yet.`, 409);
    }
    if (mapping.status === 'unsubscribed') {
      throw new RelayError(`${mapping.clientEmail} unsubscribed from ${repo}.`, 409);
    }
    return mapping;
  }

  return {
    installation,

    listMappings() {
      return db.listMappings(pool, installationId);
    },

    // A new or changed address gets a confirmation email; digests start
    // only after the client clicks it.
    async setMapping({ repo, clientName, clientEmail, branch = null }) {
      const { mapping, needsConfirmation } = await db.upsertMapping(pool, installationId, {
        repo, clientName, clientEmail, branch,
      });
      if (needsConfirmation) {
        await pipeline.sendConfirmation({
          installationId,
          accountLogin: installation.account_login,
          client: mapping,
          repo,
        });
      }
      return { ...mapping, confirmationSent: needsConfirmation };
    },

    async removeMapping({ repo }) {
      return { repo, removed: await db.deleteMapping(pool, installationId, repo) };
    },

    previewDigest({ repo, commits }) {
      if (!config.claude.enabled) throw new RelayError('Claude summaries are turned off on this server.', 503);
      return pipeline.previewDigest({ repo, commits });
    },

    async sendTestDigest({ repo }) {
      const mapping = await requireActiveMapping(repo);
      await pipeline.sendTestDigest({ installationId, client: mapping, repo });
      return { repo, sentTo: mapping.clientEmail };
    },

    listDigests({ repo, limit = 10 } = {}) {
      return db.listDigests(pool, installationId, { repo, limit });
    },

    async getDigest({ deliveryId }) {
      const digest = await db.getDigest(pool, installationId, deliveryId);
      if (!digest) throw new RelayError(`No digest found for delivery ${deliveryId}.`, 404);
      return digest;
    },

    async resendDigest({ deliveryId }) {
      const digest = await this.getDigest({ deliveryId });
      const mapping = await requireActiveMapping(digest.repo);
      await pipeline.resendDigest({ installationId, client: mapping, digest });
      return { deliveryId, sentTo: mapping.clientEmail };
    },

    async getUsage() {
      const usage = await db.getMonthlyUsage(pool, installationId);
      return { ...usage, monthlyCap: config.claude.monthlyCap, claudeEnabled: config.claude.enabled };
    },
  };
}

module.exports = { createRelayService, RelayError };