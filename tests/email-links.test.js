const request = require('supertest');
const { createApp } = require('../server');
const db = require('../lib/db');
const { createTestDb } = require('./helpers/db');
const { testConfig, testPipeline } = require('./helpers/fixtures');

let testDb, pool, app, links;
const INSTALLATION = 8001;
const target = { installationId: INSTALLATION, repo: 'acme/site', email: 'jane@acme.test' };
const tokenOf = (url) => new URL(url).searchParams.get('token');

beforeAll(async () => {
  testDb = await createTestDb();
  pool = testDb.pool;
  await db.upsertInstallation(pool, { id: INSTALLATION, accountLogin: 'acme', accountType: 'User' });
  const config = testConfig();
  const mocks = testPipeline(config);
  links = mocks.links;
  app = createApp({ config, pool, queue: {}, pipeline: mocks.pipeline, links, github: {} });
});
afterAll(() => testDb.destroy());

beforeEach(async () => {
  await db.deleteMapping(pool, INSTALLATION, 'acme/site');
  await db.upsertMapping(pool, INSTALLATION, { repo: 'acme/site', clientName: 'Jane', clientEmail: 'jane@acme.test' });
});

const status = async () => (await db.getMapping(pool, INSTALLATION, 'acme/site')).status;

test('opening the confirm link only shows a button; posting it confirms', async () => {
  const token = tokenOf(links.confirmUrl(target));
  const page = await request(app).get(`/confirm?token=${token}`);
  expect(page.status).toBe(200);
  expect(page.text).toContain('<form method="post" action="/confirm">');
  expect(await status()).toBe('pending');

  const done = await request(app).post('/confirm').type('form').send({ token });
  expect(done.status).toBe(200);
  expect(await status()).toBe('active');
});

test('an invalid confirm link changes nothing', async () => {
  expect((await request(app).post('/confirm').type('form').send({ token: 'forged.token' })).status).toBe(400);
  expect(await status()).toBe('pending');
});

test('one-click unsubscribe works the way mail providers send it', async () => {
  await db.confirmMapping(pool, INSTALLATION, 'acme/site', 'jane@acme.test');
  const url = links.unsubscribeUrl(target);
  const res = await request(app)
    .post(`/unsubscribe?token=${tokenOf(url)}`)
    .type('form')
    .send('List-Unsubscribe=One-Click');
  expect(res.status).toBe(200);
  expect(await status()).toBe('unsubscribed');
});

test('a confirm link for an address that was changed since does nothing', async () => {
  await db.upsertMapping(pool, INSTALLATION, { repo: 'acme/site', clientName: 'Jane', clientEmail: 'new@acme.test' });
  const res = await request(app).post('/confirm').type('form').send({ token: tokenOf(links.confirmUrl(target)) });
  expect(res.status).toBe(400);
  expect(await status()).toBe('pending');
});

test('pages escape what they echo back', async () => {
  const evil = { ...target, repo: '<script>alert(1)</script>' };
  const page = await request(app).get(`/unsubscribe?token=${tokenOf(links.unsubscribeUrl(evil))}`);
  expect(page.text).not.toContain('<script>alert(1)</script>');
  expect(page.text).toContain('&lt;script&gt;');
});