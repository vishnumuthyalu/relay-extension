const crypto = require('crypto');
const request = require('supertest');
const { createApp } = require('../server');
const db = require('../lib/db');
const { createTestDb } = require('./helpers/db');
const { testConfig, testPipeline, sign } = require('./helpers/fixtures');

let testDb, pool, app, queue;
const config = testConfig();

beforeAll(async () => { testDb = await createTestDb(); pool = testDb.pool; });
afterAll(() => testDb.destroy());

beforeEach(() => {
  queue = { enqueuePush: jest.fn().mockResolvedValue('job-1') };
  const { pipeline, links } = testPipeline(config);
  app = createApp({ config, pool, queue, pipeline, links, github: {} });
});

let nextInstallation = 5000;
async function activeInstallation({ branch = null } = {}) {
  const id = nextInstallation++;
  await db.upsertInstallation(pool, { id, accountLogin: 'acme', accountType: 'Organization' });
  await db.upsertMapping(pool, id, { repo: 'acme/site', clientName: 'Jane', clientEmail: 'jane@acme.test', branch });
  await db.confirmMapping(pool, id, 'acme/site', 'jane@acme.test');
  return id;
}

function push(installationId, overrides = {}) {
  return {
    ref: 'refs/heads/main',
    installation: { id: installationId },
    repository: { full_name: 'acme/site', default_branch: 'main', owner: { login: 'acme', type: 'Organization' } },
    pusher: { name: 'octocat' },
    commits: [{ id: 'a1', message: 'feat: saved cards\n\nDetails', url: 'https://github.com/acme/site/commit/a1', author: { name: 'Jane' } }],
    ...overrides,
  };
}

function deliver(payload, { event = 'push', deliveryId = crypto.randomUUID(), secret } = {}) {
  const raw = JSON.stringify(payload);
  return request(app)
    .post('/webhook/github')
    .set('content-type', 'application/json')
    .set('X-Hub-Signature-256', sign(raw, secret))
    .set('X-GitHub-Event', event)
    .set('X-GitHub-Delivery', deliveryId)
    .send(raw);
}

describe('push deliveries', () => {
  test('rejects a bad signature', async () => {
    const res = await deliver(push(1), { secret: 'wrong' });
    expect(res.status).toBe(401);
  });

  test('queues a push to the default branch of an active mapping with 202', async () => {
    const inst = await activeInstallation();
    const res = await deliver(push(inst));
    expect(res.status).toBe(202);
    expect(queue.enqueuePush).toHaveBeenCalledWith(expect.objectContaining({
      installationId: inst,
      repo: 'acme/site',
      pusher: 'octocat',
      totalCommits: 1,
      commits: [{ message: 'feat: saved cards\n\nDetails', author: { name: 'Jane' } }],
    }));
  });

  test('a repeated delivery is a duplicate and is queued once', async () => {
    const inst = await activeInstallation();
    const deliveryId = crypto.randomUUID();
    const [a, b] = await Promise.all([deliver(push(inst), { deliveryId }), deliver(push(inst), { deliveryId })]);
    expect([a.body.status, b.body.status].sort()).toEqual(['accepted', 'duplicate']);
    expect(queue.enqueuePush).toHaveBeenCalledTimes(1);
  });

  test('follows the mapping\'s branch when one is set', async () => {
    const inst = await activeInstallation({ branch: 'release' });
    expect((await deliver(push(inst))).body.status).toBe('filtered');
    expect((await deliver(push(inst, { ref: 'refs/heads/release' }))).status).toBe(202);
  });

  test.each([
    ['a tag', { ref: 'refs/tags/v1.0.0' }],
    ['another branch', { ref: 'refs/heads/feature/main' }],
    ['a deleted branch', { deleted: true, commits: [] }],
    ['no commits', { commits: [] }],
    ['an unmapped repo', { repository: { full_name: 'acme/other', default_branch: 'main' } }],
  ])('filters %s', async (_label, overrides) => {
    const inst = await activeInstallation();
    const res = await deliver(push(inst, overrides));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('filtered');
    expect(queue.enqueuePush).not.toHaveBeenCalled();
  });

  test('filters pushes until the client confirms', async () => {
    const inst = nextInstallation++;
    await db.upsertInstallation(pool, { id: inst, accountLogin: 'acme', accountType: 'User' });
    await db.upsertMapping(pool, inst, { repo: 'acme/site', clientName: 'J', clientEmail: 'j@acme.test' });
    expect((await deliver(push(inst))).body.status).toBe('filtered');
  });

  test('filters pushes for a suspended installation', async () => {
    const inst = await activeInstallation();
    await db.setInstallationSuspended(pool, inst, true);
    expect((await deliver(push(inst))).body.status).toBe('filtered');
  });

  test('creates an installation it has not seen yet from the push', async () => {
    const inst = nextInstallation++;
    const res = await deliver(push(inst));
    expect(res.body.status).toBe('filtered'); // no mapping yet
    expect(await db.getInstallation(pool, inst)).toMatchObject({ account_login: 'acme', account_type: 'Organization' });
  });

  test('releases the claim and fails when the queue is down', async () => {
    const inst = await activeInstallation();
    queue.enqueuePush.mockRejectedValueOnce(new Error('queue down'));
    const deliveryId = crypto.randomUUID();
    expect((await deliver(push(inst), { deliveryId })).status).toBe(500);
    expect((await deliver(push(inst), { deliveryId })).status).toBe(202);
  });

  test('rejects a signed but malformed push', async () => {
    const res = await deliver({ ref: 'refs/heads/main' });
    expect(res.status).toBe(400);
  });
});

describe('installation events', () => {
  const installationEvent = (action, id) => ({
    action,
    installation: { id, account: { login: 'globex', type: 'Organization' } },
    sender: { id: 99, login: 'hank' },
  });

  test('created adds the installation and makes the installer a member', async () => {
    const id = nextInstallation++;
    const res = await deliver(installationEvent('created', id), { event: 'installation' });
    expect(res.body).toEqual({ status: 'handled' });
    expect(await db.isMember(pool, id, 99)).toBe(true);
  });

  test('suspend and unsuspend toggle the installation', async () => {
    const id = nextInstallation++;
    await deliver(installationEvent('created', id), { event: 'installation' });
    await deliver(installationEvent('suspend', id), { event: 'installation' });
    expect((await db.getInstallation(pool, id)).suspended_at).not.toBeNull();
    await deliver(installationEvent('unsuspend', id), { event: 'installation' });
    expect((await db.getInstallation(pool, id)).suspended_at).toBeNull();
  });

  test('deleted removes the installation and its mappings', async () => {
    const id = await activeInstallation();
    await deliver(installationEvent('deleted', id), { event: 'installation' });
    expect(await db.getInstallation(pool, id)).toBeNull();
    expect(await db.listMappings(pool, id)).toEqual([]);
  });

  test('ignores ping and other events', async () => {
    const res = await deliver({ zen: 'Keep it logically awesome.' }, { event: 'ping' });
    expect(res.body).toEqual({ status: 'filtered' });
  });
});