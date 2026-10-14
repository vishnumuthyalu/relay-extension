const request = require('supertest');
const { createApp } = require('../server');
const db = require('../lib/db');
const { createTestDb } = require('./helpers/db');
const { testConfig, testPipeline, fakeGithub, signIn, formValue } = require('./helpers/fixtures');

let testDb, pool, app, mocks;
const USER = { githubUserId: 801, login: 'jane' };
const MINE = { id: 8101, accountLogin: 'jane', accountType: 'User' };
const OTHER = { id: 8102, accountLogin: 'globex', accountType: 'Organization' };

beforeAll(async () => {
  testDb = await createTestDb();
  pool = testDb.pool;
  await db.upsertInstallation(pool, OTHER);
});
afterAll(() => testDb.destroy());
const INTEGRATIONS_KEY = require('crypto').randomBytes(32).toString('base64');

beforeEach(() => {
  const config = testConfig({ INTEGRATIONS_KEY });
  mocks = testPipeline(config);
  app = createApp({ config, pool, queue: {}, pipeline: mocks.pipeline, links: mocks.links, github: fakeGithub(USER, [MINE]) });
});

async function openAccount(agent) {
  const res = await agent.get(`/dashboard/${MINE.id}`);
  expect(res.status).toBe(200);
  return { res, csrf: formValue(res.text, '_csrf') };
}

test('signed-out visitors are sent through sign-in and back', async () => {
  const res = await request(app).get('/dashboard');
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe('/auth/login?returnTo=%2Fdashboard');
});

test('lists the accounts the user can manage', async () => {
  const agent = await signIn(request.agent(app));
  const res = await agent.get('/dashboard');
  expect(res.text).toContain(`href="/dashboard/${MINE.id}"`);
  expect(res.text).not.toContain('globex');
});

test('adding a client sends a confirmation and shows it as waiting', async () => {
  const agent = await signIn(request.agent(app));
  const { csrf } = await openAccount(agent);
  const post = await agent.post(`/dashboard/${MINE.id}/mappings`).type('form')
    .send({ _csrf: csrf, repo: 'jane/site', clientName: 'Acme', clientEmail: 'c@acme.test' });
  expect(post.status).toBe(302);
  expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'c@acme.test' }));

  const { res } = await openAccount(agent);
  expect(res.text).toContain('A confirmation email went to c@acme.test.');
  expect(res.text).toContain('waiting for confirmation');
});

test('invalid input is reported, not saved', async () => {
  const agent = await signIn(request.agent(app));
  const { csrf } = await openAccount(agent);
  await agent.post(`/dashboard/${MINE.id}/mappings`).type('form')
    .send({ _csrf: csrf, repo: 'not a repo', clientName: 'A', clientEmail: 'a@a.test' });
  const { res } = await openAccount(agent);
  expect(res.text).toContain('Use the owner/repo form');
  expect(await db.getMapping(pool, MINE.id, 'not a repo')).toBeNull();
});

test('forms without the CSRF token are refused', async () => {
  const agent = await signIn(request.agent(app));
  const res = await agent.post(`/dashboard/${MINE.id}/mappings`).type('form')
    .send({ repo: 'jane/x', clientName: 'A', clientEmail: 'a@a.test' });
  expect(res.status).toBe(403);
  expect(await db.getMapping(pool, MINE.id, 'jane/x')).toBeNull();
});

test('another tenant\'s account is a 404', async () => {
  const agent = await signIn(request.agent(app));
  expect((await agent.get(`/dashboard/${OTHER.id}`)).status).toBe(404);
});

test('user-supplied text is escaped on the page', async () => {
  const agent = await signIn(request.agent(app));
  const { csrf } = await openAccount(agent);
  await agent.post(`/dashboard/${MINE.id}/mappings`).type('form')
    .send({ _csrf: csrf, repo: 'jane/xss', clientName: '<img src=x onerror=alert(1)>', clientEmail: 'x@x.test' });
  const { res } = await openAccount(agent);
  expect(res.text).not.toContain('<img src=x');
  expect(res.text).toContain('&lt;img src=x');
});

test('sign out clears the session', async () => {
  const agent = await signIn(request.agent(app));
  const { csrf } = await openAccount(agent);
  const out = await agent.post('/dashboard/logout').type('form').send({ _csrf: csrf });
  expect(out.status).toBe(302);
  expect(out.headers.location).toBe('/signed-out');
  expect((await agent.get('/signed-out')).text).toContain('signed out');
  expect((await agent.get('/dashboard')).status).toBe(302);
});

test('connecting a ticket tracker stores the token encrypted and never shows it', async () => {
  const agent = await signIn(request.agent(app));
  const { csrf } = await openAccount(agent);
  const res = await agent.post(`/dashboard/${MINE.id}/integration`).type('form').send({
    _csrf: csrf, name: 'Linear', mcpUrl: 'https://mcp.tracker.example/mcp', token: 'lin_api_supersecret', allowedTools: 'get_issue, search_issues',
  });
  expect(res.status).toBe(302);

  const row = await db.getIntegration(pool, MINE.id);
  expect(row.allowed_tools).toEqual(['get_issue', 'search_issues']);
  expect(row.token_encrypted).not.toContain('supersecret');

  const { res: page } = await openAccount(agent);
  expect(page.text).toContain('Ticket tracker: <strong>Linear</strong>');
  expect(page.text).not.toContain('supersecret');
});

test('a tracker on a private host is refused', async () => {
  const agent = await signIn(request.agent(app));
  const { csrf } = await openAccount(agent);
  await agent.post(`/dashboard/${MINE.id}/integration/remove`).type('form').send({ _csrf: csrf });
  await agent.post(`/dashboard/${MINE.id}/integration`).type('form').send({
    _csrf: csrf, name: 'Evil', mcpUrl: 'https://169.254.169.254/latest', token: 't', allowedTools: 'get_issue',
  });
  const { res } = await openAccount(agent);
  expect(res.text).toContain('must be https on a public host');
  expect(await db.getIntegration(pool, MINE.id)).toBeNull();
});
