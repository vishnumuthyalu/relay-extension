require('dotenv/config');
const path = require('path');
const express = require('express');
const OpenApiValidator = require('express-openapi-validator');

const { verifyGithubSignature, requireConfigKey } = require('./lib/security');
const { openDb, upsertClient, getClient, isDuplicateDelivery, markDeliveryProcessed } = require('./lib/db');
const { summarizeWithClaude } = require('./lib/claude');
const { renderEmailHtml, sendEmail } = require('./lib/email');

// Fail fast: a missing secret in production should crash on boot, not
// on the first webhook delivery.
const REQUIRED_ENV = ['GITHUB_WEBHOOK_SECRET', 'ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'FROM_EMAIL', 'CONFIG_API_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const db = openDb();
const app = express();

const helmet = require('helmet');
app.use(helmet());

const rateLimit = require('express-rate-limit');
const configLimiter = rateLimit({ windowMs: 60_000, limit: 20 });

app.use(
  express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
  })
);

const pinoHttp = require('pino-http');
app.use(pinoHttp());

app.use(
  OpenApiValidator.middleware({
    apiSpec: path.join(__dirname, 'spec', 'openapi.yaml'),
    validateRequests: true,
    validateResponses: true,
  })
);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/webhook/github', async (req, res, next) => {
  try {
    const signature = req.get('X-Hub-Signature-256');
    if (!verifyGithubSignature(req.rawBody, signature, process.env.GITHUB_WEBHOOK_SECRET)) {
      return res.status(401).json({ error: 'invalid signature' });
    }
    if (req.get('X-GitHub-Event') !== 'push') {
      return res.json({ status: 'filtered' });
    }

    const deliveryId = req.get('X-GitHub-Delivery');
    if (isDuplicateDelivery(db, deliveryId)) {
      return res.json({ status: 'duplicate' });
    }

    const { ref, repository, pusher, commits } = req.body;
    const onlyBranch = process.env.ONLY_BRANCH;
    if (onlyBranch && !ref.endsWith(`/${onlyBranch}`)) {
      markDeliveryProcessed(db, deliveryId, repository.full_name);
      return res.json({ status: 'filtered' });
    }

    const client = getClient(db, repository.full_name);
    if (!client) {
      markDeliveryProcessed(db, deliveryId, repository.full_name);
      return res.json({ status: 'filtered' });
    }

    const summary = await summarizeWithClaude({
      repo: repository.full_name,
      pusher: pusher.name,
      commits,
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    await sendEmail({
      to: client.client_email,
      subject: summary.headline,
      html: renderEmailHtml({ clientName: client.client_name, repo: repository.full_name, pusher: pusher.name, summary }),
      apiKey: process.env.RESEND_API_KEY,
      fromEmail: process.env.FROM_EMAIL,
    });

    markDeliveryProcessed(db, deliveryId, repository.full_name);
    res.json({ status: 'processed' });
  } catch (err) {
    next(err);
  }
});

app.post('/config', configLimiter, requireConfigKey(process.env.CONFIG_API_KEY), (req, res) => {
  const saved = upsertClient(db, req.body);
  res.json({ repo: saved.repo, clientEmail: saved.client_email, clientName: saved.client_name });
});

app.post('/test', configLimiter, requireConfigKey(process.env.CONFIG_API_KEY), async (req, res, next) => {
  try {
    const client = getClient(db, req.body.repo);
    if (!client) return res.status(404).json({ error: 'no client mapped to that repo' });

    const summary = {
      headline: `Test digest for ${req.body.repo}`,
      summary: 'This is a sample update email generated on demand.',
      highlights: ['This is a sample highlight.'],
      risk_notes: null,
    };
    await sendEmail({
      to: client.client_email,
      subject: summary.headline,
      html: renderEmailHtml({ clientName: client.client_name, repo: req.body.repo, pusher: 'test', summary }),
      apiKey: process.env.RESEND_API_KEY,
      fromEmail: process.env.FROM_EMAIL,
    });
    res.json({ sent: true });
  } catch (err) {
    next(err);
  }
});

// OpenAPI validator errors + everything else land here
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'internal error' });
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Relay listening on :${port}`));
}

module.exports = { app, db };