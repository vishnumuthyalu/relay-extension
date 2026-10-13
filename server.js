require('dotenv/config');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const OpenApiValidator = require('express-openapi-validator');

const { requireGithubSignature, requireConfigKey } = require('./lib/security');
const {
  openDb, upsertClient, getClient, claimDelivery, completeDelivery, releaseDelivery, recordDigest,} = require('./lib/db');
const { createPipeline } = require('./lib/pipeline');


// Fail fast: a missing secret in production should crash on boot, not
// on the first webhook delivery.
const REQUIRED_ENV = ['GITHUB_WEBHOOK_SECRET', 'ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'FROM_EMAIL', 'CONFIG_API_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

// GitHub caps webhook payloads at 25 MB; 5 MB comfortably covers large
// pushes without letting arbitrary callers send huge bodies.
const WEBHOOK_BODY_LIMIT = '5mb';

function createApp({ db = openDb(), pipeline = createPipeline() } = {}) {
  const app = express();
  // Background deliveries still running; tests await these.
  app.locals.inflight = new Set();

  app.use(helmet());
  app.use(pinoHttp({ enabled: process.env.NODE_ENV !== 'test' }));
  const configLimiter = rateLimit({ windowMs: 60_000, limit: 20 });

  const keepRawBody = (req, _res, buf) => { req.rawBody = buf; };

  // Webhook: parse with a larger limit and verify the HMAC BEFORE the
  // OpenAPI validator runs, so unsigned requests get a bare 401 and never
  // see schema error details. express.json() below skips bodies that are
  // already parsed.
  app.use(
    '/webhook/github',
    express.json({ limit: WEBHOOK_BODY_LIMIT, verify: keepRawBody }),
    requireGithubSignature(process.env.GITHUB_WEBHOOK_SECRET)
  );

  app.use(express.json({ verify: keepRawBody }));

  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(__dirname, 'spec', 'openapi.yaml'),
      validateRequests: true,
      validateResponses: true,
    })
  );

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  app.post('/webhook/github', (req, res) => {
    if (req.get('X-GitHub-Event') !== 'push') {
      return res.json({ status: 'filtered' });
    }

    const deliveryId = req.get('X-GitHub-Delivery');
    const payload = req.body;
    const repo = payload.repository.full_name;

    if (!claimDelivery(db, deliveryId, repo)) {
      return res.json({ status: 'duplicate' });
    }

    const filtered = () => {
      completeDelivery(db, deliveryId);
      return res.json({ status: 'filtered' });
    };

    // Branch pushes only; tags and other refs are ignored.
    if (!payload.ref.startsWith('refs/heads/')) return filtered();
    const branch = payload.ref.slice('refs/heads/'.length);
    const onlyBranch = process.env.ONLY_BRANCH;
    if (onlyBranch && branch !== onlyBranch) return filtered();

    // Branch deletions and pushes with nothing new have nothing to report.
    if (payload.deleted || !payload.commits?.length) return filtered();

    const client = getClient(db, repo);
    if (!client) return filtered();

    // Reply now; GitHub only needs to know we accepted the delivery.
    res.status(202).json({ status: 'accepted' });

    const job = pipeline.processPush({ payload, client })
      .then((result) => {
        recordDigest(db, { deliveryId, repo, ...result });
        completeDelivery(db, deliveryId);
      })
      .catch((err) => {
        req.log.error({ err, deliveryId }, 'delivery processing failed');
        releaseDelivery(db, deliveryId);
      })
      .finally(() => app.locals.inflight.delete(job));
    app.locals.inflight.add(job);
  });

  app.post('/config', configLimiter, requireConfigKey(process.env.CONFIG_API_KEY), (req, res) => {
    const saved = upsertClient(db, req.body);
    res.json({ repo: saved.repo, clientEmail: saved.client_email, clientName: saved.client_name });
  });

  app.post('/test', configLimiter, requireConfigKey(process.env.CONFIG_API_KEY), async (req, res, next) => {
    try {
      const client = getClient(db, req.body.repo);
      if (!client) return res.status(404).json({ error: 'no client mapped to that repo' });
      
      await pipeline.sendTestDigest({ repo: req.body.repo, client });

      res.json({ sent: true });
    } catch (err) {
      next(err);
    }
  });

  // OpenAPI validator errors + everything else land here
  app.use((err, req, res, _next) => {
    req.log?.error({ err }, 'request failed');
    res.status(err.status || 500).json({ error: err.message || 'internal error' });
  });

  return app;
}

const db = openDb();
const app = createApp({ db });

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Relay listening on :${port}`));
}

module.exports = { app, db, createApp };
