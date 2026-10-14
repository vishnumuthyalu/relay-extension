const express = require('express');
const db = require('../lib/db');
const { createRelayService, RelayError } = require('../lib/service');
const { requireUser, requireInstallationAccess } = require('./auth');

// JSON API for the signed-in user. Every route under /api/installations/:id
// is scoped to one installation the user is a member of. Request and
// response shapes are enforced by spec/openapi.yaml.
function createApiRouter({ pool, pipeline, config, github }) {
  const router = express.Router();
  router.use('/api', requireUser);

  router.get('/api/me', async (req, res) => {
    const installations = await db.listUserInstallations(pool, req.user.githubUserId);
    res.json({
      login: req.user.login,
      installUrl: github.installUrl,
      installations: installations.map((i) => ({
        id: i.id,
        accountLogin: i.account_login,
        accountType: i.account_type,
        suspended: Boolean(i.suspended_at),
      })),
    });
  });

  const scoped = express.Router({ mergeParams: true });
  router.use('/api/installations/:installationId', requireInstallationAccess(pool), (req, _res, next) => {
    req.relay = createRelayService({ pool, pipeline, config, installation: req.installation });
    next();
  }, scoped);

  const repoOf = (req) => `${req.params.owner}/${req.params.repo}`;

  scoped.get('/mappings', async (req, res) => {
    res.json({ mappings: await req.relay.listMappings() });
  });

  scoped.put('/mappings/:owner/:repo', async (req, res) => {
    const { clientName, clientEmail, branch = null } = req.body;
    res.json(await req.relay.setMapping({ repo: repoOf(req), clientName, clientEmail, branch }));
  });

  scoped.delete('/mappings/:owner/:repo', async (req, res) => {
    const { removed } = await req.relay.removeMapping({ repo: repoOf(req) });
    if (!removed) return res.status(404).json({ error: 'no mapping for that repo' });
    res.status(204).end();
  });

  scoped.post('/mappings/:owner/:repo/test', async (req, res) => {
    res.json(await req.relay.sendTestDigest({ repo: repoOf(req) }));
  });

  scoped.get('/digests', async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 10;
    res.json({ digests: await req.relay.listDigests({ repo: req.query.repo, limit }) });
  });

  scoped.get('/usage', async (req, res) => {
    res.json(await req.relay.getUsage());
  });

  // RelayError → a 4xx with its message; anything else goes to the app's handler.
  router.use((err, req, res, next) => {
    if (err instanceof RelayError) return res.status(err.status).json({ error: err.message });
    next(err);
  });

  return router;
}

module.exports = { createApiRouter };