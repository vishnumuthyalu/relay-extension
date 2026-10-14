const express = require('express');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const pushEventSchema = require('../spec/push-event.schema.json');
const { requireGithubSignature } = require('../lib/security');
const { MAX_COMMITS_IN_PROMPT } = require('../lib/claude');
const db = require('../lib/db');

const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
const validatePush = ajv.compile(pushEventSchema);

// GitHub caps webhook payloads at 25 MB; 5 MB covers large pushes without
// letting arbitrary callers send huge bodies.
const WEBHOOK_BODY_LIMIT = '5mb';

async function handleInstallationEvent(pool, body) {
  const { action, installation, sender } = body;
  const id = installation.id;
  switch (action) {
    case 'created':
      await db.upsertInstallation(pool, {
        id, accountLogin: installation.account.login, accountType: installation.account.type,
      });
      // Whoever installed the app can manage it straight away.
      await db.addMember(pool, id, sender.id);
      break;
    case 'deleted':
      // Purges mappings, digests and usage for the tenant (ON DELETE CASCADE).
      await db.deleteInstallation(pool, id);
      break;
    case 'suspend':
      await db.setInstallationSuspended(pool, id, true);
      break;
    case 'unsuspend':
      await db.setInstallationSuspended(pool, id, false);
      break;
    default:
      break;
  }
}

async function handlePush(pool, queue, req, res) {
  const deliveryId = req.get('X-GitHub-Delivery');
  const payload = req.body;
  if (!validatePush(payload)) {
    return res.status(400).json({ error: `invalid push payload: ${ajv.errorsText(validatePush.errors)}` });
  }

  const installationId = payload.installation?.id;
  if (!installationId) return res.json({ status: 'filtered' }); // not a GitHub App delivery
  const repo = payload.repository.full_name;

  // Pushes can arrive for an installation Relay missed the "created" event
  // for (e.g. the app was installed while Relay was down).
  let installation = await db.getInstallation(pool, installationId);
  if (!installation) {
    await db.upsertInstallation(pool, {
      id: installationId,
      accountLogin: payload.repository.owner?.login ?? repo.split('/')[0],
      accountType: payload.repository.owner?.type ?? 'User',
    });
    installation = await db.getInstallation(pool, installationId);
  }

  if (!(await db.claimDelivery(pool, { deliveryId, installationId, repo }))) {
    return res.json({ status: 'duplicate' });
  }

  const filtered = async (reason) => {
    await db.completeDelivery(pool, deliveryId, `filtered:${reason}`);
    return res.json({ status: 'filtered' });
  };

  if (installation.suspended_at) return filtered('suspended');
  if (!payload.ref.startsWith('refs/heads/')) return filtered('not-a-branch');
  if (payload.deleted || payload.commits.length === 0) return filtered('no-commits');

  const mapping = await db.getMapping(pool, installationId, repo);
  if (!mapping) return filtered('unmapped');
  if (mapping.status !== 'active') return filtered(mapping.status);

  // Each mapping follows one branch: its own setting, else the repo's default.
  const branch = payload.ref.slice('refs/heads/'.length);
  const watched = mapping.branch || payload.repository.default_branch || 'main';
  if (branch !== watched) return filtered('branch');

  try {
    await queue.enqueuePush({
      deliveryId,
      installationId,
      repo,
      pusher: payload.pusher.name,
      // Only what the summary needs; keeps job rows small.
      commits: payload.commits.slice(0, MAX_COMMITS_IN_PROMPT).map((c) => ({
        message: c.message,
        author: c.author?.name ? { name: c.author.name } : undefined,
      })),
      totalCommits: payload.commits.length,
    });
  } catch (err) {
    // Couldn't queue it: give the claim back and let GitHub see a failure.
    await db.releaseDelivery(pool, deliveryId);
    throw err;
  }
  return res.status(202).json({ status: 'accepted' });
}

function createWebhookRouter({ pool, queue, config }) {
  const router = express.Router();

  // Parse with a larger limit and verify the HMAC before anything else
  // looks at the body; unsigned requests get a bare 401.
  router.post(
    '/webhook/github',
    express.json({ limit: WEBHOOK_BODY_LIMIT, verify: (req, _res, buf) => { req.rawBody = buf; } }),
    requireGithubSignature(config.github.webhookSecret),
    async (req, res, next) => {
      try {
        const event = req.get('X-GitHub-Event');
        if (event === 'push') return await handlePush(pool, queue, req, res);
        if (event === 'installation') {
          await handleInstallationEvent(pool, req.body);
          return res.json({ status: 'handled' });
        }
        // ping, installation_repositories and anything else: nothing to do.
        return res.json({ status: 'filtered' });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}

module.exports = { createWebhookRouter, validatePush };