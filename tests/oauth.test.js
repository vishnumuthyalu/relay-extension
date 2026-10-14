const crypto = require('crypto');
const request = require('supertest');
const { createApp } = require('../server');
const db = require('../lib/db');
const { createTestDb } = require('./helpers/db');
const { testConfig, testPipeline, fakeGithub, signIn, formValue } = require('./helpers/fixtures');

let testDb, pool, app, fetchImpl;
const config = testConfig();
const USER = { githubUserId: 601, login: 'jane' };
const REDIRECT = 'http://127.0.0.1/callback';
const RESOURCE = 'https://relay.test/mcp';

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

beforeAll(async () => {
  testDb = await createTestDb();
  pool = testDb.pool;
  await db.upsertInstallation(pool, { id: 6001, accountLogin: 'jane', accountType: 'User' });
});
afterAll(() => testDb.destroy());

beforeEach(() => {
  // Serves Client ID Metadata Documents for the CIMD tests.
  fetchImpl = jest.fn(async (url) => {
    if (url === 'https://client.example/relay.json') {
      return new Response(JSON.stringify({
        client_id: url, client_name: 'Example Desktop', redirect_uris: ['http://127.0.0.1/cb'],
      }));
    }
    return new Response('not found', { status: 404 });
  });
  const { pipeline, links } = testPipeline(config);
  const github = fakeGithub(USER, [{ id: 6001, accountLogin: 'jane', accountType: 'User' }]);
  app = createApp({ config, pool, queue: {}, pipeline, links, github, fetchImpl });
});

async function register(redirectUris = [REDIRECT]) {
  const res = await request(app).post('/oauth/register').send({ client_name: 'Test Client', redirect_uris: redirectUris });
  return res.body.client_id;
}

function authorizeUrl(clientId, { challenge, redirectUri = REDIRECT, scope, resource = RESOURCE, state = 'xyz' } = {}) {
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', state, resource,
  });
  if (scope) q.set('scope', scope);
  return `/oauth/authorize?${q}`;
}

// Signs in, opens the consent page, clicks Allow, returns the redirect.
async function approve(clientId, opts) {
  const agent = await signIn(request.agent(app));
  const consent = await agent.get(authorizeUrl(clientId, opts));
  expect(consent.status).toBe(200);
  const fields = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'scope', 'state', 'resource', '_csrf'];
  const body = Object.fromEntries(fields.map((f) => [f, formValue(consent.text, f)]));
  const res = await agent.post('/oauth/authorize').type('form').send({ ...body, decision: 'allow' });
  expect(res.status).toBe(302);
  return { location: new URL(res.headers.location), consent, agent };
}

const token = (body) => request(app).post('/oauth/token').type('form').send(body);

describe('discovery', () => {
  test('serves protected resource metadata for /mcp', async () => {
    const res = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    expect(res.body).toMatchObject({
      resource: RESOURCE,
      authorization_servers: ['https://relay.test'],
      scopes_supported: ['relay:read', 'relay:write', 'relay:send'],
    });
  });

  test('serves authorization server metadata', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.body).toMatchObject({
      issuer: 'https://relay.test',
      authorization_endpoint: 'https://relay.test/oauth/authorize',
      token_endpoint: 'https://relay.test/oauth/token',
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
    });
  });
});

describe('registration', () => {
  test('registers a public client', async () => {
    const res = await request(app).post('/oauth/register').send({ client_name: 'X', redirect_uris: [REDIRECT] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
    expect(res.body.client_id).toMatch(/^relay_/);
  });

  test.each([['http://evil.test/cb'], ['javascript:alert(1)'], ['https://ok.test/cb#frag']])(
    'rejects the redirect URI %s', async (uri) => {
      const res = await request(app).post('/oauth/register').send({ redirect_uris: [uri] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_redirect_uri');
    });
});

describe('authorization', () => {
  test('an unknown client or unregistered redirect gets an error page, never a redirect', async () => {
    const { challenge } = pkce();
    const unknown = await request(app).get(authorizeUrl('relay_nope', { challenge }));
    expect(unknown.status).toBe(400);

    const clientId = await register();
    const wrong = await request(app).get(authorizeUrl(clientId, { challenge, redirectUri: 'http://127.0.0.1/other' }));
    expect(wrong.status).toBe(400);
    expect(wrong.headers.location).toBeUndefined();
  });

  test('sends the user through sign-in first', async () => {
    const clientId = await register();
    const res = await request(app).get(authorizeUrl(clientId, { challenge: pkce().challenge }));
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/auth\/login\?returnTo=%2Foauth%2Fauthorize/);
  });

  test('a missing or wrong resource is sent back as invalid_target', async () => {
    const clientId = await register();
    const agent = await signIn(request.agent(app));
    const res = await agent.get(authorizeUrl(clientId, { challenge: pkce().challenge, resource: 'https://elsewhere.test/mcp' }));
    const location = new URL(res.headers.location);
    expect(location.searchParams.get('error')).toBe('invalid_target');
    expect(location.searchParams.get('state')).toBe('xyz');
  });

  test('the consent page names the client and only allows posting to its redirect', async () => {
    const clientId = await register();
    const agent = await signIn(request.agent(app));
    const res = await agent.get(authorizeUrl(clientId, { challenge: pkce().challenge }));
    expect(res.text).toContain('Allow Test Client to use Relay?');
    expect(res.headers['content-security-policy']).toContain("form-action 'self' http://127.0.0.1");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  test('a loopback redirect may use any port', async () => {
    const clientId = await register();
    const { location } = await approve(clientId, { challenge: pkce().challenge, redirectUri: 'http://127.0.0.1:54321/callback' });
    expect(location.origin).toBe('http://127.0.0.1:54321');
    expect(location.searchParams.get('code')).toBeTruthy();
  });

  test('posting without the CSRF token is refused', async () => {
    const clientId = await register();
    const agent = await signIn(request.agent(app));
    const res = await agent.post('/oauth/authorize').type('form').send({
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge,
      code_challenge_method: 'S256', resource: RESOURCE, decision: 'allow',
    });
    expect(res.status).toBe(403);
  });

  test('Cancel returns access_denied', async () => {
    const clientId = await register();
    const agent = await signIn(request.agent(app));
    const consent = await agent.get(authorizeUrl(clientId, { challenge: pkce().challenge }));
    const res = await agent.post('/oauth/authorize').type('form').send({
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: formValue(consent.text, 'code_challenge'),
      code_challenge_method: 'S256', resource: RESOURCE, state: 'xyz', _csrf: formValue(consent.text, '_csrf'), decision: 'deny',
    });
    expect(new URL(res.headers.location).searchParams.get('error')).toBe('access_denied');
  });

  test('a Client ID Metadata Document client works without registering', async () => {
    const clientId = 'https://client.example/relay.json';
    const { location, consent } = await approve(clientId, { challenge: pkce().challenge, redirectUri: 'http://127.0.0.1/cb' });
    expect(consent.text).toContain('Example Desktop');
    expect(location.searchParams.get('code')).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledWith(clientId, expect.objectContaining({ redirect: 'error' }));
  });

  test('client metadata URLs on private hosts are never fetched', async () => {
    const res = await request(app).get(authorizeUrl('https://127.0.0.1/relay.json', { challenge: pkce().challenge }));
    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('tokens', () => {
  test('exchanges a code with PKCE, once, and refreshes with rotation', async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const { location } = await approve(clientId, { challenge, scope: 'relay:read relay:write' });
    expect(location.searchParams.get('iss')).toBe('https://relay.test');
    const code = location.searchParams.get('code');

    const wrongVerifier = await token({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: pkce().verifier, resource: RESOURCE });
    expect(wrongVerifier.status).toBe(400);
    expect(wrongVerifier.body.error).toBe('invalid_grant');

    // A failed attempt burns the code too: codes are single-use.
    const reused = await token({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: RESOURCE });
    expect(reused.body.error).toBe('invalid_grant');

    const second = await approve(clientId, { challenge, scope: 'relay:read relay:write' });
    const ok = await token({
      grant_type: 'authorization_code', code: second.location.searchParams.get('code'),
      client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier, resource: RESOURCE,
    });
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'relay:read relay:write' });

    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: ok.body.refresh_token, client_id: clientId });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(ok.body.refresh_token);

    const replay = await token({ grant_type: 'refresh_token', refresh_token: ok.body.refresh_token, client_id: clientId });
    expect(replay.body.error).toBe('invalid_grant');
  });

  test('a code issued to one client cannot be redeemed by another', async () => {
    const a = await register();
    const b = await register();
    const { verifier, challenge } = pkce();
    const { location } = await approve(a, { challenge });
    const res = await token({
      grant_type: 'authorization_code', code: location.searchParams.get('code'),
      client_id: b, redirect_uri: REDIRECT, code_verifier: verifier, resource: RESOURCE,
    });
    expect(res.body.error).toBe('invalid_grant');
  });

  test('unknown clients and grant types are rejected', async () => {
    expect((await token({ grant_type: 'authorization_code', client_id: 'relay_nope' })).body.error).toBe('invalid_client');
    const clientId = await register();
    expect((await token({ grant_type: 'password', client_id: clientId })).body.error).toBe('unsupported_grant_type');
  });
});
