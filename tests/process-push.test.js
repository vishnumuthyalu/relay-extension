const db = require('../lib/db');
const { createProcessPush } = require('../lib/jobs/process-push');
const { createTestDb } = require('./helpers/db');
const { testConfig, testPipeline } = require('./helpers/fixtures');

let testDb, pool;
beforeAll(async () => { testDb = await createTestDb(); pool = testDb.pool; });
afterAll(() => testDb.destroy());

let nextId = 9000;
async function setup({ status = 'active', config = testConfig() } = {}) {
  const installationId = nextId++;
  await db.upsertInstallation(pool, { id: installationId, accountLogin: 'acme', accountType: 'User' });
  await db.upsertMapping(pool, installationId, { repo: 'acme/site', clientName: 'Jane', clientEmail: 'jane@acme.test' });
  if (status !== 'pending') await db.confirmMapping(pool, installationId, 'acme/site', 'jane@acme.test');
  if (status === 'unsubscribed') await db.unsubscribeMapping(pool, installationId, 'acme/site', 'jane@acme.test');

  const mocks = testPipeline(config);
  const processPush = createProcessPush({ pool, pipeline: mocks.pipeline, config });
  const job = (deliveryId) => ({
    deliveryId,
    installationId,
    repo: 'acme/site',
    pusher: 'octocat',
    commits: [{ message: 'feat: saved cards' }, { message: 'fix: rounding' }],
    totalCommits: 2,
  });
  const claim = (deliveryId) => db.claimDelivery(pool, { deliveryId, installationId, repo: 'acme/site' });
  return { installationId, processPush, job, claim, ...mocks };
}

const deliveryRow = async (id) => (await pool.query('SELECT * FROM deliveries WHERE delivery_id = $1', [id])).rows[0];

test('sends a Claude-written digest with an unsubscribe header and records it', async () => {
  const t = await setup();
  await t.claim('p-1');
  await expect(t.processPush(t.job('p-1'))).resolves.toEqual({ outcome: 'sent', kind: 'ai' });

  expect(t.summarize).toHaveBeenCalledTimes(1);
  const email = t.send.mock.calls[0][0];
  expect(email.to).toBe('jane@acme.test');
  expect(email.headers['List-Unsubscribe']).toMatch(/^<https:\/\/relay\.test\/unsubscribe\?token=/);
  expect(email.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  expect(email.html).toContain('Unsubscribe');

  expect(await db.getDigest(pool, t.installationId, 'p-1')).toMatchObject({ kind: 'ai', commitCount: 2 });
  expect(await db.getMonthlyUsage(pool, t.installationId)).toMatchObject({ digestsSent: 1, inputTokens: 100, outputTokens: 50 });
  expect(await deliveryRow('p-1')).toMatchObject({ status: 'done', outcome: 'sent:ai' });
});

test('over the monthly cap, sends a plain digest without calling Claude', async () => {
  const t = await setup();
  for (let i = 0; i < 3; i++) await db.addUsage(pool, t.installationId, { kind: 'ai' }); // cap is 3 in tests
  await t.claim('p-cap');
  await expect(t.processPush(t.job('p-cap'))).resolves.toEqual({ outcome: 'sent', kind: 'fallback' });

  expect(t.summarize).not.toHaveBeenCalled();
  expect(t.send.mock.calls[0][0].subject).toBe('2 new updates on acme/site');
  expect(t.send.mock.calls[0][0].html).toContain('feat: saved cards');
  expect(await db.getMonthlyUsage(pool, t.installationId)).toMatchObject({ digestsSent: 3, fallbackSent: 1 });
});

test('with Claude switched off, every digest is plain', async () => {
  const t = await setup({ config: testConfig({ CLAUDE_ENABLED: 'false' }) });
  await t.claim('p-off');
  await expect(t.processPush(t.job('p-off'))).resolves.toMatchObject({ kind: 'fallback' });
  expect(t.summarize).not.toHaveBeenCalled();
});

test.each(['pending', 'unsubscribed'])('does not email a %s client', async (status) => {
  const t = await setup({ status });
  await t.claim(`p-${status}`);
  await expect(t.processPush(t.job(`p-${status}`))).resolves.toEqual({ outcome: 'filtered' });
  expect(t.send).not.toHaveBeenCalled();
  expect(await deliveryRow(`p-${status}`)).toMatchObject({ status: 'done', outcome: `filtered:${status}` });
});

test('a retry after the email was sent does not send it again', async () => {
  const t = await setup();
  await t.claim('p-twice');
  await t.processPush(t.job('p-twice'));
  await expect(t.processPush(t.job('p-twice'))).resolves.toEqual({ outcome: 'already-sent' });
  expect(t.send).toHaveBeenCalledTimes(1);
});

test('a failure keeps the claim until the final attempt, then releases it', async () => {
  const t = await setup();
  t.send.mockRejectedValue(new Error('Resend down'));
  await t.claim('p-fail');

  await expect(t.processPush(t.job('p-fail'))).rejects.toThrow('Resend down');
  expect(await deliveryRow('p-fail')).toMatchObject({ status: 'processing' });

  await expect(t.processPush(t.job('p-fail'), { isFinalAttempt: true })).rejects.toThrow('Resend down');
  expect(await deliveryRow('p-fail')).toBeUndefined();
});