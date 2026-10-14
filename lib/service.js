const db = require('./db');
const { encrypt, parseKey } = require('./crypto-box');
const { isPublicHttpsUrl } = require('./oauth/clients');

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

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

    
    // ---- richer summaries (Phase 5) ----------------------------------------

    async getSummarySettings() {
      const fresh = await db.getInstallation(pool, installationId);
      const integration = await db.getIntegration(pool, installationId);
      return {
        enrichmentEnabled: fresh.enrichment_enabled,
        githubContextAvailable: Boolean(config.github.appId && config.github.privateKey),
        integrationsAvailable: Boolean(config.integrationsKey),
        // The token is never returned.
        integration: integration && {
          name: integration.name,
          mcpUrl: integration.mcp_url,
          allowedTools: integration.allowed_tools,
          updatedAt: integration.updated_at.toISOString(),
        },
      };
    },

    async setEnrichment(enabled) {
      await db.setEnrichment(pool, installationId, Boolean(enabled));
    },

    // Connects a ticket tracker's remote MCP server. Only the listed tools
    // can ever be called, so list read-only ones (e.g. get_issue).
    async saveIntegration({ name, mcpUrl, token, allowedTools }) {
      if (!config.integrationsKey) throw new RelayError('Ticket trackers are not enabled on this server.', 503);
      if (!name || name.length > 40) throw new RelayError('Give the tracker a short name, e.g. Linear.');
      if (!isPublicHttpsUrl(mcpUrl)) throw new RelayError('The MCP server URL must be https on a public host.');
      if (!token || token.length > 4096) throw new RelayError('Paste the access token for the tracker.');
      if (!Array.isArray(allowedTools) || allowedTools.length === 0 || allowedTools.length > 10
        || !allowedTools.every((t) => TOOL_NAME.test(t))) {
        throw new RelayError('List 1–10 read-only tool names, separated by commas.');
      }
      await db.upsertIntegration(pool, installationId, {
        name, mcpUrl, allowedTools, tokenEncrypted: encrypt(token, parseKey(config.integrationsKey)),
      });
    },

    async removeIntegration() {
      await db.deleteIntegration(pool, installationId);
    },

  };
}

module.exports = { createRelayService, RelayError };