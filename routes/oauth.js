const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { mcpAuthMetadataRouter } = require('@modelcontextprotocol/express');
const { page, hidden, escapeHtml } = require('../lib/html');
const { csrfToken, validCsrf } = require('../lib/csrf');
const { redirectMatches } = require('../lib/oauth/clients');
const { grantableScopes, SCOPES } = require('../lib/oauth/tokens');

// Relay's OAuth 2.1 authorization server for the remote MCP endpoint.
// GitHub does the actual sign-in (routes/auth.js); this layer issues
// tokens that are only valid for Relay's own /mcp URL, as the MCP
// authorization spec requires.

const SCOPE_TEXT = {
  'relay:read': 'See your client mappings, digest history and usage, and preview digests',
  'relay:write': 'Add, change and remove client mappings (new clients get a confirmation email)',
  'relay:send': 'Send test digests and resend past digests to confirmed clients',
};

function asMetadata({ publicUrl }) {
  return {
    issuer: publicUrl,
    authorization_endpoint: `${publicUrl}/oauth/authorize`,
    token_endpoint: `${publicUrl}/oauth/token`,
    registration_endpoint: `${publicUrl}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SCOPES,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

// The consent page posts to /oauth/authorize, which then redirects to the
// client. Browsers apply CSP form-action to that redirect too, so the page
// allows exactly this client's redirect target (an origin, or a native
// app's scheme). frame-ancestors 'none' stops clickjacking of the Allow button.
function consentCsp(redirectUri) {
  const url = new URL(redirectUri);
  const target = url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : url.protocol;
  return [
    "default-src 'self'", "base-uri 'none'", `form-action 'self' ${target}`, "frame-ancestors 'none'",
    "object-src 'none'", "script-src 'none'", "style-src 'unsafe-inline'",
  ].join('; ');
}

function createOAuthRouter({ config, clients, tokens }) {
  const router = express.Router();
  const issuer = config.publicUrl;
  const resource = `${config.publicUrl}/mcp`;
  const form = express.urlencoded({ extended: false, limit: '16kb' });
  // Token and registration endpoints are called by MCP clients, some of
  // which run in a browser, so they allow cross-origin requests.
  const allowAnyOrigin = cors({ origin: '*', methods: ['GET', 'POST'] });
  const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

  // RFC 9728 protected resource metadata for /mcp, plus RFC 8414
  // authorization server metadata, from the MCP SDK's Express adapter.
  router.use(allowAnyOrigin, mcpAuthMetadataRouter({
    oauthMetadata: asMetadata({ publicUrl: issuer }),
    resourceServerUrl: new URL(resource),
    scopesSupported: SCOPES,
    resourceName: 'Relay',
    dangerouslyAllowInsecureIssuerUrl: !config.production && issuer.startsWith('http://localhost'),
  }));

  // ---- registration (RFC 7591) ------------------------------------------

  router.options('/oauth/register', allowAnyOrigin);
  router.post('/oauth/register', allowAnyOrigin, limiter, express.json({ limit: '16kb' }), async (req, res, next) => {
    try {
      const client = await clients.register(req.body || {});
      res.status(201).set('Cache-Control', 'no-store').json({
        client_id: client.clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: client.clientName ?? undefined,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    } catch (err) {
      if (err.oauthError) return res.status(400).json({ error: err.oauthError, error_description: err.message });
      next(err);
    }
  });

  // ---- authorization ------------------------------------------------------

  // Validates an authorization request. Problems with the client or the
  // redirect URI are shown on a page (never redirected to an unverified
  // URI); anything else is sent back to the client as an OAuth error.
  async function checkRequest(params) {
    const client = await clients.resolve(params.client_id);
    if (!client) return { fatal: 'This app is not registered with Relay, or its client metadata could not be loaded.' };
    const redirectUri = params.redirect_uri;
    if (!redirectUri || !client.redirectUris.some((r) => redirectMatches(r, redirectUri))) {
      return { fatal: 'The redirect address this app sent does not match the ones it registered.' };
    }
    const back = (error, description) => ({ client, redirectUri, error, description });
    if (params.response_type !== 'code') return back('unsupported_response_type', 'only response_type=code is supported');
    if (!params.code_challenge || params.code_challenge_method !== 'S256') {
      return back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    if (params.resource !== resource) return back('invalid_target', `resource must be ${resource}`);
    const scopes = grantableScopes(params.scope);
    if (scopes.length === 0) return back('invalid_scope', `supported scopes: ${SCOPES.join(' ')}`);
    return { client, redirectUri, scopes };
  }

  function redirectBack(res, redirectUri, params) {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries({ ...params, iss: issuer })) if (v !== undefined) url.searchParams.set(k, v);
    res.redirect(url.toString());
  }

  function consentPage(req, check, params) {
    const items = check.scopes.map((s) => `<li>${escapeHtml(SCOPE_TEXT[s])}</li>`).join('');
    const fields = hidden({
      response_type: params.response_type,
      client_id: params.client_id,
      redirect_uri: params.redirect_uri,
      code_challenge: params.code_challenge,
      code_challenge_method: params.code_challenge_method,
      scope: check.scopes.join(' '),
      state: params.state,
      resource: params.resource,
      _csrf: csrfToken(req),
    });
    // Show where the code will be sent: a host, or a native app's scheme.
    const target = new URL(check.redirectUri);
    const returnsTo = escapeHtml(target.host || target.protocol);
    return page(`Allow ${check.client.clientName} to use Relay?`, `
      <p>Signed in as <strong>${escapeHtml(req.session.login)}</strong>. <strong>${escapeHtml(check.client.clientName)}</strong>
      (returning to <code>${returnsTo}</code>) is asking to:</p>
      <ul>${items}</ul>
      <p class="muted">It can act on every Relay account you can manage. You can sign out of the app at any time to stop it.</p>
      <form method="post" action="/oauth/authorize" class="inline">${fields}
        <button type="submit" name="decision" value="allow">Allow</button>
        <button type="submit" name="decision" value="deny">Cancel</button>
      </form>`);
  }

  router.get('/oauth/authorize', async (req, res, next) => {
    try {
      const check = await checkRequest(req.query);
      if (check.fatal) return res.status(400).send(page('Cannot continue', `<p>${escapeHtml(check.fatal)}</p>`));
      if (check.error) {
        return redirectBack(res, check.redirectUri, { error: check.error, error_description: check.description, state: req.query.state });
      }
      if (!req.session?.uid) return res.redirect(`/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
      res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': consentCsp(check.redirectUri) })
        .send(consentPage(req, check, req.query));
    } catch (err) {
      next(err);
    }
  });

  router.post('/oauth/authorize', form, async (req, res, next) => {
    try {
      const params = req.body;
      const check = await checkRequest(params);
      if (check.fatal) return res.status(400).send(page('Cannot continue', `<p>${escapeHtml(check.fatal)}</p>`));
      if (!req.session?.uid || !validCsrf(req)) {
        return res.status(403).send(page('Please try again', '<p>Your session expired. Go back to the app and connect again.</p>'));
      }
      if (check.error) return redirectBack(res, check.redirectUri, { error: check.error, error_description: check.description, state: params.state });
      if (params.decision !== 'allow') return redirectBack(res, check.redirectUri, { error: 'access_denied', state: params.state });

      const code = await tokens.createCode({
        clientId: check.client.clientId,
        githubUserId: req.session.uid,
        redirectUri: check.redirectUri,
        codeChallenge: params.code_challenge,
        scopes: check.scopes,
        resource,
      });
      redirectBack(res, check.redirectUri, { code, state: params.state });
    } catch (err) {
      next(err);
    }
  });

  // ---- token --------------------------------------------------------------

  router.options('/oauth/token', allowAnyOrigin);
  router.post('/oauth/token', allowAnyOrigin, limiter, form, async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const p = req.body || {};
    try {
      if (!(await clients.resolve(p.client_id))) {
        return res.status(401).json({ error: 'invalid_client', error_description: 'unknown client_id' });
      }
      let body;
      if (p.grant_type === 'authorization_code') {
        body = await tokens.exchangeCode({
          code: p.code, clientId: p.client_id, redirectUri: p.redirect_uri, codeVerifier: p.code_verifier, resource: p.resource,
        });
      } else if (p.grant_type === 'refresh_token') {
        body = await tokens.refresh({ refreshToken: p.refresh_token, clientId: p.client_id, resource: p.resource });
      } else {
        return res.status(400).json({ error: 'unsupported_grant_type' });
      }
      res.json(body);
    } catch (err) {
      if (err.oauthError) return res.status(400).json({ error: err.oauthError, error_description: err.message });
      next(err);
    }
  });

  return router;
}

module.exports = { createOAuthRouter, asMetadata, SCOPE_TEXT };
