const { githubContext, formatGithubContext } = require('./github');
const { extractTicketKeys, ticketContext } = require('./tickets');
const { decrypt } = require('../crypto-box');

// Gathers optional background for one push: GitHub PR context and ticket
// notes. Each source is independent and best-effort; a failure is logged
// and skipped, so a slow or broken tracker never blocks a digest.
//
// Returns { text, usage } where text is '' when there's nothing to add.
function createContextGatherer({ config, githubApp, integrationsKey, fetchImpl = fetch, log = console }) {
  return async function gatherContext({ installation, integration, job }) {
    const parts = [];
    const usage = { inputTokens: 0, outputTokens: 0 };

    if (installation.enrichment_enabled && githubApp) {
      try {
        const gh = await githubContext({
          githubApp, installationId: installation.id, repo: job.repo, before: job.before, after: job.after,
        });
        const text = formatGithubContext(gh);
        if (text) parts.push(text);
      } catch (err) {
        log.warn?.({ err, deliveryId: job.deliveryId }, 'github context skipped');
      }
    }

    if (integration && integrationsKey) {
      try {
        const keys = extractTicketKeys([job.ref, ...job.commits.map((c) => c.message)]);
        const result = await ticketContext({
          integration,
          token: decrypt(integration.token_encrypted, integrationsKey),
          keys,
          apiKey: config.claude.apiKey,
          model: config.claude.model || 'claude-haiku-4-5',
          fetchImpl,
        });
        if (result.notes) parts.push(`Tickets:\n${result.notes}`);
        if (result.usage) {
          usage.inputTokens += result.usage.inputTokens;
          usage.outputTokens += result.usage.outputTokens;
        }
      } catch (err) {
        log.warn?.({ err, deliveryId: job.deliveryId }, 'ticket context skipped');
      }
    }

    return { text: parts.join('\n\n').slice(0, 4000), usage };
  };
}

module.exports = { createContextGatherer };