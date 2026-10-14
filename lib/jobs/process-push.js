const db = require('../db');

// Processes one claimed push delivery: re-checks the mapping (it may have
// changed while the job waited), picks Claude or the plain fallback based
// on the monthly cap, optionally gathers PR and ticket context, emails the
// client and records what happened.
//
// `pool` is a pg Pool. Throwing lets the queue retry; when `isFinalAttempt`
// is true the claim is released first, so a manual GitHub redelivery can
// still retry it later. `gatherContext` (lib/context) is optional.
function createProcessPush({ pool, pipeline, config, gatherContext = null }) {
  return async function processPush(job, { isFinalAttempt = false } = {}) {
    const { deliveryId, installationId, repo, pusher, commits, totalCommits } = job;
    try {
      // A retry after the email went out but before the delivery was
      // marked done must not email the client a second time.
      if (await db.getDigest(pool, installationId, deliveryId)) {
        await db.completeDelivery(pool, deliveryId, 'sent:retry-skipped');
        return { outcome: 'already-sent' };
      }

      const mapping = await db.getMapping(pool, installationId, repo);
      if (!mapping || mapping.status !== 'active') {
        await db.completeDelivery(pool, deliveryId, `filtered:${mapping ? mapping.status : 'unmapped'}`);
        return { outcome: 'filtered' };
      }

      const usage = await db.getMonthlyUsage(pool, installationId);
      const useClaude = config.claude.enabled && usage.digestsSent < config.claude.monthlyCap;

            // Extra context only matters when Claude writes the summary.
      let context = { text: '', usage: { inputTokens: 0, outputTokens: 0 } };
      if (useClaude && gatherContext) {
        const installation = await db.getInstallation(pool, installationId);
        const integration = await db.getIntegration(pool, installationId);
        if (installation.enrichment_enabled || integration) {
          context = await gatherContext({ installation, integration, job });
        }
      }

      const digest = await pipeline.buildDigest({
        repo, pusher, commits, totalCommits, useClaude, context: context.text || undefined,
      });
      await pipeline.emailDigest({ installationId, client: mapping, repo, pusher, summary: digest.summary });

      // Record the digest straight after sending. If anything below fails,
      // the retry finds this row and stops instead of emailing again.
      await db.recordDigest(pool, installationId, {
        deliveryId,
        repo,
        recipient: mapping.clientEmail,
        summary: digest.summary,
        commitCount: totalCommits,
        model: digest.model,
        kind: digest.kind,
      });
      await db.addUsage(pool, installationId, {
        kind: digest.kind,
        inputTokens: (digest.usage?.inputTokens ?? 0) + context.usage.inputTokens,
        outputTokens: (digest.usage?.outputTokens ?? 0) + context.usage.outputTokens,
      });
      await db.completeDelivery(pool, deliveryId, `sent:${digest.kind}`);
      return { outcome: 'sent', kind: digest.kind, enriched: Boolean(context.text) };
    } catch (err) {
      if (isFinalAttempt) await db.releaseDelivery(pool, deliveryId);
      throw err;
    }
  };
}

module.exports = { createProcessPush };