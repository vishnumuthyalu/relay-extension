const crypto = require('crypto');
const request = require('supertest');
const { createApp } = require('../server');
const { openDb, upsertClient, listDigests } = require('../lib/db');

const SECRET = process.env.GITHUB_WEBHOOK_SECRET;

function push(overrides = {}) {
  return {
    ref: 'refs/heads/main',
    repository: { full_name: 'acme/site' },
    pusher: { name: 'octocat' },
    commits: [{ id: 'a1b2c3d', message: 'Fix bug', url: 'https://github.com/acme/site/commit/a1b2c3d' }],
    ...overrides,
  };
}

function deliver(app, payload, { deliveryId = crypto.randomUUID(), event = 'push', secret = SECRET } = {}) {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return request(app)
    .post('/webhook/github')
    .set('content-type', 'application/json')
    .set('X-Hub-Signature-256', sig)
    .set('X-GitHub-Event', event)
    .set('X-GitHub-Delivery', deliveryId)
    .send(raw);
}

describe('POST /webhook/github', () => {
  let db, pipeline, app;

  beforeEach(() => {
    process.env.ONLY_BRANCH = 'main';
    db = openDb(':memory:');
    upsertClient(db, { repo: 'acme/site', clientName: 'Acme', clientEmail: 'client@acme.test' });
    pipeline = {
      processPush: jest.fn().mockResolvedValue({
        summary: { headline: 'Shipped', summary: 'x'.repeat(30), highlights: ['A'], risk_notes: null },
        recipient: 'client@acme.test',
        commitCount: 1,
        model: 'claude-haiku-4-5',
      }),
    };
    app = createApp({ db, pipeline });
  });

  const settle = () => Promise.all([...app.locals.inflight]);

  test('rejects a bad signature without schema details', async () => {
    const res = await deliver(app, { not: 'a push' }, { secret: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid signature' });
  });

  test('accepts a valid push with 202 and processes it in the background', async () => {
    const res = await deliver(app, push());
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'accepted' });
    await settle();
    expect(pipeline.processPush).toHaveBeenCalledTimes(1);
    expect(listDigests(db)).toHaveLength(1);
  });

  test.each([
    ['a branch that only ends in /main', push({ ref: 'refs/heads/feature/main' })],
    ['a tag push', push({ ref: 'refs/tags/v1.0.0' })],
    ['a deleted branch', push({ deleted: true, commits: [] })],
    ['a push with no commits', push({ commits: [] })],
    ['an unmapped repo', push({ repository: { full_name: 'acme/other' } })],
  ])('filters %s', async (_label, payload) => {
    const res = await deliver(app, payload);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('filtered');
    expect(pipeline.processPush).not.toHaveBeenCalled();
  });

  test('two concurrent copies of one delivery are processed once', async () => {
    const deliveryId = crypto.randomUUID();
    const [a, b] = await Promise.all([deliver(app, push(), { deliveryId }), deliver(app, push(), { deliveryId })]);
    expect([a.body.status, b.body.status].sort()).toEqual(['accepted', 'duplicate']);
    await settle();
    expect(pipeline.processPush).toHaveBeenCalledTimes(1);
  });

  test('a failed delivery is released so a redelivery can retry it', async () => {
    pipeline.processPush.mockRejectedValueOnce(new Error('Resend down'));
    const deliveryId = crypto.randomUUID();
    await deliver(app, push(), { deliveryId });
    await settle();
    const retry = await deliver(app, push(), { deliveryId });
    expect(retry.status).toBe(202);
    await settle();
    expect(pipeline.processPush).toHaveBeenCalledTimes(2);
  });

  test('accepts payloads larger than the default 100 KB body limit', async () => {
    const commits = Array.from({ length: 400 }, (_, i) => ({
      id: `c${i}`, message: `Commit ${i} `.padEnd(400, 'x'), url: `https://github.com/acme/site/commit/c${i}`,
    }));
    const res = await deliver(app, push({ commits }));
    expect(res.status).toBe(202);
    await settle();
  });
});
