const request = require('supertest');
const { createApp } = require('../server');
const db = require('../lib/db');
const { createTestDb } = require('./helpers/db');
const { testConfig, testPipeline } = require('./helpers/fixtures');

let testDb, pool, app, mocks;
const config = testConfig();
const USER = { githubUserId: 501, login: 'jane' };
const MINE = 7001;
const THEIRS = 7002;

// GitHub is stubbed: sign-in always returns USER with access to MINE only.
const github = {
  installUrl: 'https://github.com/apps/relay-test/installations/new',
  authorizeUrl: ({ state }) => `https://github.test/login/oauth/authorize?state=${state}`,
  exchangeCode: jest.fn().mockResolvedValue('user-token'),
  getUser: jest.fn().mockResolvedValue(USER),
  listInstallations: jest.fn().mockResolvedValue([{ id: MINE, accountLogin: 'jane', accountType: 'User' }]),
};

beforeAll(async () => {
  testDb = await createTestDb();
  pool = testDb.pool;
  await db.upsertInstallation(pool, { id: THEIRS, accountLogin: 'globex', accountType: 'Organization' });
  await db.upsertMapping(pool, THEIRS, { repo: 'globex/secret', clientName: 'G', clientEmail: 'g@globex.test' });
});
afterAll(() => testDb.destroy());

beforeEach(() => {
  mocks = testPipeline(config);
  app = createApp({ config, pool, queue: {}, pipeline: mocks.pipeline, links: mocks.links, github });
});

// Runs the real /auth/login → /auth/callback flow and returns an agent
// holding the session cookie.
async function signIn() {
  const agent = request.agent(app);
  const login = await agent.get('/auth/login');
  expect(login.status).toBe(302);
  const state = new URL(login.headers.location).searchParams.get('state');
  const callback = await agent.get(`/auth/callback?code=abc&state=${state}`);
  expect(callback.status).toBe(302);
  expect(callback.headers.location).toBe('/api/me');
  return agent;
}

describe('sign-in', () => {
  test('the API requires a session', async () => {
    expect((await request(app).get('/api/me')).status).toBe(401);
  });

  test('a callback with the wrong state is rejected', async () => {
    const agent = request.agent(app);
    await agent.get('/auth/login');
    expect((await agent.get('/auth/callback?code=abc&state=forged')).status).toBe(400);
  });

  test('signing in syncs memberships and lists the user\'s installations', async () => {
    const agent = await signIn();
    const me = await agent.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      login: 'jane',
      installUrl: github.installUrl,
      installations: [{ id: MINE, accountLogin: 'jane', accountType: 'User', suspended: false }],
    });
  });

  test('returnTo only accepts same-site paths', async () => {
    const agent = request.agent(app);
    const login = await agent.get('/auth/login?returnTo=//evil.test');
    const state = new URL(login.headers.location).searchParams.get('state');
    const callback = await agent.get(`/auth/callback?code=abc&state=${state}`);
    expect(callback.headers.location).toBe('/api/me');
  });

  test('/install redirects to the GitHub App install page', async () => {
    const res = await request(app).get('/install');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(github.installUrl);
  });

  test('logout clears the session', async () => {
    const agent = await signIn();
    expect((await agent.post('/auth/logout')).status).toBe(204);
    expect((await agent.get('/api/me')).status).toBe(401);
  });
});

describe('mappings API', () => {
  test('creating a mapping sends a confirmation email and starts pending', async () => {
    const agent = await signIn();
    const res = await agent
      .put(`/api/installations/${MINE}/mappings/jane/site`)
      .send({ clientName: 'Acme', clientEmail: 'client@acme.test' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ repo: 'jane/site', status: 'pending', confirmationSent: true, branch: null });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'client@acme.test',
      subject: 'Confirm project updates for jane/site',
      html: expect.stringContaining('https://relay.test/confirm?token='),
    }));

    const list = await agent.get(`/api/installations/${MINE}/mappings`);
    expect(list.body.mappings.map((m) => m.repo)).toContain('jane/site');
  });

  test('rejects an invalid email via the OpenAPI contract', async () => {
    const agent = await signIn();
    const res = await agent.put(`/api/installations/${MINE}/mappings/jane/site`).send({ clientName: 'A', clientEmail: 'nope' });
    expect(res.status).toBe(400);
  });

  test('a test digest is refused until the client confirms', async () => {
    const agent = await signIn();
    await agent.put(`/api/installations/${MINE}/mappings/jane/blog`).send({ clientName: 'A', clientEmail: 'a@acme.test' });
    const pending = await agent.post(`/api/installations/${MINE}/mappings/jane/blog/test`);
    expect(pending.status).toBe(409);

    await db.confirmMapping(pool, MINE, 'jane/blog', 'a@acme.test');
    const ok = await agent.post(`/api/installations/${MINE}/mappings/jane/blog/test`);
    expect(ok.body).toEqual({ repo: 'jane/blog', sentTo: 'a@acme.test' });
  });

  test('deleting a mapping returns 204, then 404', async () => {
    const agent = await signIn();
    await agent.put(`/api/installations/${MINE}/mappings/jane/tmp`).send({ clientName: 'A', clientEmail: 'a@acme.test' });
    expect((await agent.delete(`/api/installations/${MINE}/mappings/jane/tmp`)).status).toBe(204);
    expect((await agent.delete(`/api/installations/${MINE}/mappings/jane/tmp`)).status).toBe(404);
  });

  test('another tenant\'s installation looks like it does not exist', async () => {
    const agent = await signIn();
    expect((await agent.get(`/api/installations/${THEIRS}/mappings`)).status).toBe(404);
    expect((await agent.delete(`/api/installations/${THEIRS}/mappings/globex/secret`)).status).toBe(404);
    expect(await db.getMapping(pool, THEIRS, 'globex/secret')).not.toBeNull();
  });

  test('usage and digests are available', async () => {
    const agent = await signIn();
    const usage = await agent.get(`/api/installations/${MINE}/usage`);
    expect(usage.body).toMatchObject({ digestsSent: 0, monthlyCap: 3, claudeEnabled: true });
    const digests = await agent.get(`/api/installations/${MINE}/digests?limit=5`);
    expect(digests.body).toEqual({ digests: [] });
  });
});