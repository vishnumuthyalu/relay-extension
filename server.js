// Web process: GitHub webhooks, the remote MCP endpoint and its OAuth
// server, sign-in, the dashboard, the JSON API and the email link pages.
// Digests are sent by the worker process (worker.js), not here.
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
const { deriveKey } = require('./lib/oauth/jwt');
const { createClientRegistry } = require('./lib/oauth/clients');
const { createTokenService } = require('./lib/oauth/tokens');
const { createWebhookRouter } = require('./routes/webhook');
const { createMcpRouter } = require('./routes/mcp');
const { createOAuthRouter } = require('./routes/oauth');
const { createAuthRouter } = require('./routes/auth');
const { createDashboardRouter, createLogoutRoute } = require('./routes/dashboard');
const { createApiRouter } = require('./routes/api');
const { createLinksRouter } = require('./routes/links');

function createApp({ config, pool, queue, github, pipeline, links, fetchImpl = fetch }) {
  const app = express();
  app.set('trust proxy', 1); // behind the host's TLS-terminating proxy
  app.use(helmet());
  app.use(pinoHttp({ enabled: process.env.NODE_ENV !== 'test' }));

  const tokens = createTokenService({ pool, key: deriveKey(config.sessionSecret), issuer: config.publicUrl });
  const clients = createClientRegistry({ pool, fetchImpl });

  // Machine endpoints first; none of them use the session cookie.
  // Webhooks need the raw body for the HMAC check.
  app.use(createWebhookRouter({ pool, queue, config }));
  const mcp = createMcpRouter({ pool, pipeline, config, tokens, github });
  app.use(mcp.router);
  app.locals.closeMcp = mcp.close;

  app.use(cookieSession({
    name: 'relay_session',
    keys: [config.sessionSecret],
    httpOnly: true,
    sameSite: 'lax',   // not sent on cross-site POSTs, which blocks CSRF on the API
    secure: config.production,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  }));

  // OAuth for MCP clients (metadata, register, authorize, token), then the
  // browser-facing pages.
  app.use(createOAuthRouter({ config, clients, tokens }));
  app.use(createAuthRouter({ pool, github, config }));
  app.use(createLogoutRoute());
  app.use(createDashboardRouter({ pool, pipeline, config }));
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
      // Routes above answer before reaching here; these are HTML, OAuth or MCP.
      ignorePaths: /^\/(auth|install|confirm|unsubscribe|dashboard|oauth|mcp|\.well-known)(\/|$)/,
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
