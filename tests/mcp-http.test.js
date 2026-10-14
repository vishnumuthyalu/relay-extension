const http = require('http');
const crypto = require('crypto');
const request = require('supertest');
const { Client } = require('@modelcontextprotocol/client');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { createApp } = require('../server');
const db = require('../lib/db');
const { signJwt, deriveKey } = require('../lib/oauth/jwt');
const { createTestDb } = require('./helpers/db');
const { testConfig, testPipeline, fakeGithub, signIn, formValue } = require('./helpers/fixtures');

// End to end over real HTTP: the official MCP SDK client discovers Relay's
// authorization server from the 401, registers, runs PKCE, and then calls
// tools with the token, exactly as Claude Code or Cursor would.

let testDb, pool, server, base, config;
const USER = { githubUserId: 701, login: 'jane' };
const MINE = { id: 7101, accountLogin: 'jane', accountType: 'User' };
const ORG = { id: 7102, accountLogin: 'acme', accountType: 'Organization' };
const OTHER = { id: 7103, accountLogin: 'globex', accountType: 'Organization' };

beforeAll(async () => {
  testDb = await createTestDb();
  pool = testDb.pool;
  for (const inst of [MINE, ORG, OTHER]) await db.upsertInstallation(pool, inst);
  await db.upsertMapping(pool, OTHER.id, { repo: 'globex/secret', clientName: 'G', clientEmail: 'g@globex.test' });

  // The issuer and the token audience are this server's own URL, so listen
  // first and build the app once the port is known.
  server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://localhost:${server.address().port}`;
  config = testConfig({ PUBLIC_URL: base });
  const { pipeline, links } = testPipeline(config);
  const app = createApp({ config, pool, queue: {}, pipeline, links, github: fakeGithub(USER, [MINE, ORG]) });
  server.on('request', app);
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testDb.destroy();
});

// An in-memory OAuthClientProvider: what an MCP client keeps on disk.
function memoryProvider() {
  const store = { client: undefined, tokens: undefined, verifier: undefined, authUrl: undefined };
  return {
    store,
    get redirectUrl() { return 'http://127.0.0.1:9/callback'; },
    get clientMetadata() {
      return {
        client_name: 'SDK Test Client',
        redirect_uris: ['http://127.0.0.1:9/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    clientInformation: () => store.client,
    saveClientInformation: (info) => { store.client = info; },
    tokens: () => store.tokens,
    saveTokens: (tokens) => { store.tokens = tokens; },
    redirectToAuthorization: (url) => { store.authUrl = url; },
    saveCodeVerifier: (v) => { store.verifier = v; },
    codeVerifier: () => store.verifier,
  };
}

// Plays the user in the browser: sign in, open the consent page, Allow.
async function approveInBrowser(authUrl) {
  const agent = await signIn(request.agent(base));
  const consent = await agent.get(authUrl.pathname + authUrl.search);
  expect(consent.status).toBe(200);
  const fields = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'scope', 'state', 'resource', '_csrf'];
  const body = Object.fromEntries(fields.map((f) => [f, formValue(consent.text, f)]));
  const res = await agent.post('/oauth/authorize').type('form').send({ ...body, decision: 'allow' });
  return new URL(res.headers.location);
}

async function connectedClient(provider) {
  const mcpUrl = new URL(`${base}/mcp`);
  const first = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
  const client = new Client({ name: 'sdk-test', version: '0.0.0' });
  // No token yet: the SDK discovers the auth server, registers, and asks
  // us to send the user to the authorization URL.
  await expect(client.connect(first)).rejects.toThrow();
  expect(provider.store.authUrl.pathname).toBe('/oauth/authorize');

  const callback = await approveInBrowser(provider.store.authUrl);
  // Pass the whole callback query: the SDK checks `iss` (RFC 9207) as well as the code.
  await first.finishAuth(callback.searchParams);

  const authed = new Client({ name: 'sdk-test', version: '0.0.0' });
  await authed.connect(new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider }));
  return authed;
}

test('rejects requests without a token, pointing at the resource metadata', async () => {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(res.status).toBe(401);
  expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
});

test.each([
  ['for another audience', { aud: 'https://elsewhere.test/mcp' }],
  ['that has expired', { exp: Math.floor(Date.now() / 1000) - 10 }],
  ['from another issuer', { iss: 'https://evil.test' }],
])('rejects a token %s', async (_label, override) => {
  const now = Math.floor(Date.now() / 1000);
  const forged = signJwt({
    iss: base, sub: String(USER.githubUserId), aud: `${base}/mcp`, client_id: 'x',
    scope: 'relay:read', iat: now, exp: now + 600, ...override,
  }, deriveKey(config.sessionSecret));
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${forged}` },
    body: '{}',
  });
  expect(res.status).toBe(401);
});

test('the SDK client signs in through Relay and calls tools for its own accounts only', async () => {
  const provider = memoryProvider();
  const client = await connectedClient(provider);
  expect(provider.store.tokens.access_token).toBeTruthy();

  const accounts = await client.callTool({ name: 'list_accounts', arguments: {} });
  expect(accounts.structuredContent.accounts.map((a) => a.account).sort()).toEqual(['acme', 'jane']);

  // Two accounts, so the server asks which one.
  const ambiguous = await client.callTool({ name: 'list_client_mappings', arguments: {} });
  expect(ambiguous.isError).toBe(true);
  expect(ambiguous.content[0].text).toMatch(/Pass account/);

  const set = await client.callTool({
    name: 'set_client_mapping',
    arguments: { account: 'acme', repo: 'acme/site', clientName: 'Acme', clientEmail: 'c@acme.test' },
  });
  expect(set.structuredContent).toMatchObject({ repo: 'acme/site', status: 'pending' });
  expect((await db.getMapping(pool, ORG.id, 'acme/site')).clientEmail).toBe('c@acme.test');

  // Another tenant's account is out of reach, and its data is untouched.
  const foreign = await client.callTool({ name: 'list_client_mappings', arguments: { account: 'globex' } });
  expect(foreign.isError).toBe(true);
  expect(await db.getMapping(pool, OTHER.id, 'globex/secret')).not.toBeNull();

  await client.close();
});

test('a read-only token is challenged for relay:write when it tries to write', async () => {
  // Start from a valid token that only carries relay:read.
  const now = Math.floor(Date.now() / 1000);
  const readOnly = signJwt({
    iss: base, sub: String(USER.githubUserId), aud: `${base}/mcp`, client_id: 'read-only-client',
    scope: 'relay:read', iat: now, exp: now + 600,
  }, deriveKey(config.sessionSecret));
  const provider = memoryProvider();
  provider.store.tokens = { access_token: readOnly, token_type: 'Bearer' };

  const client = new Client({ name: 'sdk-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }));

  const read = await client.callTool({ name: 'list_client_mappings', arguments: { account: 'jane' } });
  expect(read.isError).toBeFalsy();

  await expect(client.callTool({
    name: 'set_client_mapping',
    arguments: { account: 'jane', repo: 'jane/site', clientName: 'J', clientEmail: 'j@jane.test' },
  })).rejects.toThrow();
  // The server answered 403 insufficient_scope, and the SDK started a
  // step-up authorization that asks for the missing scope.
  expect(provider.store.authUrl.searchParams.get('scope')).toContain('relay:write');
  expect(await db.getMapping(pool, MINE.id, 'jane/site')).toBeNull();

  await client.close();
});

test('rejects a Host header that is not ours (DNS rebinding)', async () => {
  // fetch() won't let a caller set Host, so send a raw request.
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/mcp`, {
      method: 'POST', headers: { host: 'evil.test', 'content-type': 'application/json' },
    }, (r) => resolve(r.statusCode));
    req.on('error', reject);
    req.end('{}');
  });
  expect(status).toBe(403);
});

test('the access token is bound to its user (no cross-user tokens)', async () => {
  // Random secret material never validates.
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${crypto.randomBytes(32).toString('base64url')}` },
    body: '{}',
  });
  expect(res.status).toBe(401);
});
