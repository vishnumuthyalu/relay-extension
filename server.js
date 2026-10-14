// Web process: GitHub webhooks, sign-in, the JSON API and the email link
// pages. Digests are sent by the worker process (worker.js), not here.
require('dotenv/config');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const cookieSession = require('cookie-session');
const OpenApiValidator = require('express-openapi-validator');

const { loadConfig } = require('./lib/config');
const { createPool } = require('./lib/db/pool');
const { migrate } = require('./lib/db/migrate');
const { createLinks } = require('./lib/links');
const { createPipeline } = require('./lib/pipeline');
const { createGithubClient } = require('./lib/github');
const { startQueue } = require('./lib/queue');
const { createWebhookRouter } = require('./routes/webhook');
const { createAuthRouter } = require('./routes/auth');
const { createApiRouter } = require('./routes/api');
const { createLinksRouter } = require('./routes/links');

function createApp({ config, pool, queue, github, pipeline, links }) {
  const app = express();
  app.set('trust proxy', 1); // behind the host's TLS-terminating proxy
  app.use(helmet());
  app.use(pinoHttp({ enabled: process.env.NODE_ENV !== 'test' }));

  // Webhooks first: they need the raw body for the HMAC check and are
  // validated against spec/push-event.schema.json inside the route.
  app.use(createWebhookRouter({ pool, queue, config }));

  app.use(cookieSession({
    name: 'relay_session',
    keys: [config.sessionSecret],
    httpOnly: true,
    sameSite: 'lax',   // not sent on cross-site POSTs, which blocks CSRF on the API
    secure: config.production,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  }));

  app.use(createAuthRouter({ pool, github, config }));
  app.use(createLinksRouter({ pool, links }));

  app.use(express.json());
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(__dirname, 'spec', 'openapi.yaml'),
      validateRequests: true,
      validateResponses: true,
      // Sign-in is enforced by requireUser in routes/api.js; the scheme in
      // the spec documents it.
      validateSecurity: false,
      // Routes above answer before reaching here; these are HTML or OAuth redirects.
      ignorePaths: /^\/(auth|install|confirm|unsubscribe)(\/|$)/,
    })
  );

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.use(createApiRouter({ pool, pipeline, config, github }));

  // OpenAPI validator errors + everything else land here
  app.use((err, req, res, _next) => {
    const status = err.status || 500;
    if (status >= 500) req.log?.error({ err }, 'request failed');
    res.status(status).json({ error: status >= 500 ? 'internal error' : err.message });
  });

  return app;
}

async function main() {
  const config = loadConfig();
  const pool = createPool({ connectionString: config.databaseUrl });
  await migrate(pool, { log: (m) => console.log(m) });
  const queue = await startQueue({ connectionString: config.databaseUrl });
  const links = createLinks({ secret: config.sessionSecret, publicUrl: config.publicUrl });
  const app = createApp({
    config,
    pool,
    queue,
    links,
    github: createGithubClient(config.github),
    pipeline: createPipeline({ config, links }),
  });
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Relay web listening on :${port}`));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createApp };