const db = require('../lib/db');
const { createTestDb } = require('./helpers/db');

let testDb, pool;
beforeAll(async () => { testDb = await createTestDb(); pool = testDb.pool; });
afterAll(() => testDb.destroy());

let nextId = 1000;
async function newInstallation(login = 'acme') {
  const id = nextId++;
  await db.upsertInstallation(pool, { id, accountLogin: login, accountType: 'Organization' });
  return id;
}

describe('delivery claims', () => {
  test('exactly one of many concurrent claims wins', async () => {
    const inst = await newInstallation();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => db.claimDelivery(pool, { deliveryId: 'race-1', installationId: inst, repo: 'acme/site' }))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test('a released claim can be retried; a completed one cannot', async () => {
    const inst = await newInstallation();
    const claim = (id) => db.claimDelivery(pool, { deliveryId: id, installationId: inst, repo: 'acme/site' });
    await claim('d-release');
    await db.releaseDelivery(pool, 'd-release');
    expect(await claim('d-release')).toBe(true);

    await claim('d-done');
    await db.completeDelivery(pool, 'd-done', 'sent:ai');
    expect(await claim('d-done')).toBe(false);
  });

  test('a stale processing claim can be taken over', async () => {
    const inst = await newInstallation();
    await db.claimDelivery(pool, { deliveryId: 'd-stale', installationId: inst, repo: 'acme/site' });
    await pool.query(`UPDATE deliveries SET claimed_at = now() - interval '1 hour' WHERE delivery_id = 'd-stale'`);
    expect(await db.claimDelivery(pool, { deliveryId: 'd-stale', installationId: inst, repo: 'acme/site' })).toBe(true);
  });
});

describe('client mappings', () => {
  const mapping = { repo: 'acme/site', clientName: 'Jane', clientEmail: 'jane@acme.test' };

  test('a new mapping is pending and needs confirmation', async () => {
    const inst = await newInstallation();
    const { mapping: m, needsConfirmation } = await db.upsertMapping(pool, inst, mapping);
    expect(m.status).toBe('pending');
    expect(needsConfirmation).toBe(true);
  });

  test('renaming keeps confirmation; changing the email resets it', async () => {
    const inst = await newInstallation();
    await db.upsertMapping(pool, inst, mapping);
    await db.confirmMapping(pool, inst, mapping.repo, mapping.clientEmail);

    const renamed = await db.upsertMapping(pool, inst, { ...mapping, clientName: 'Jane D.' });
    expect(renamed.mapping.status).toBe('active');
    expect(renamed.needsConfirmation).toBe(false);

    const moved = await db.upsertMapping(pool, inst, { ...mapping, clientEmail: 'new@acme.test' });
    expect(moved.mapping.status).toBe('pending');
    expect(moved.needsConfirmation).toBe(true);
  });

  test('confirm and unsubscribe only apply to the current address', async () => {
    const inst = await newInstallation();
    await db.upsertMapping(pool, inst, mapping);
    expect(await db.confirmMapping(pool, inst, mapping.repo, 'someone-else@acme.test')).toBe(false);
    expect(await db.confirmMapping(pool, inst, mapping.repo, mapping.clientEmail)).toBe(true);
    expect(await db.unsubscribeMapping(pool, inst, mapping.repo, mapping.clientEmail)).toBe(true);
    expect((await db.getMapping(pool, inst, mapping.repo)).status).toBe('unsubscribed');
  });

  test('one installation never sees another installation\'s mappings', async () => {
    const a = await newInstallation('a');
    const b = await newInstallation('b');
    await db.upsertMapping(pool, a, mapping);
    expect(await db.listMappings(pool, b)).toEqual([]);
    expect(await db.getMapping(pool, b, mapping.repo)).toBeNull();
    expect(await db.deleteMapping(pool, b, mapping.repo)).toBe(false);
    expect(await db.listMappings(pool, a)).toHaveLength(1);
  });
});

describe('digests and usage', () => {
  const summary = { headline: 'Shipped', summary: 'x'.repeat(30), highlights: ['A'], risk_notes: null };

  test('digests are listed newest first and scoped to the installation', async () => {
    const a = await newInstallation();
    const b = await newInstallation();
    for (const [id, repo] of [['g1', 'acme/site'], ['g2', 'acme/api'], ['g3', 'acme/site']]) {
      await db.recordDigest(pool, a, { deliveryId: id, repo, recipient: 'c@acme.test', summary, commitCount: 1, model: 'm', kind: 'ai' });
      await pool.query(`UPDATE digests SET sent_at = now() + ($2 || ' seconds')::interval WHERE delivery_id = $1`, [id, id.slice(1)]);
    }
    expect((await db.listDigests(pool, a)).map((d) => d.deliveryId)).toEqual(['g3', 'g2', 'g1']);
    expect((await db.listDigests(pool, a, { repo: 'acme/site', limit: 1 })).map((d) => d.deliveryId)).toEqual(['g3']);
    expect(await db.listDigests(pool, b)).toEqual([]);
    expect(await db.getDigest(pool, b, 'g1')).toBeNull();
  });

  test('usage accumulates per month', async () => {
    const inst = await newInstallation();
    expect(await db.getMonthlyUsage(pool, inst)).toMatchObject({ digestsSent: 0, inputTokens: 0 });
    await db.addUsage(pool, inst, { kind: 'ai', inputTokens: 100, outputTokens: 40 });
    await db.addUsage(pool, inst, { kind: 'ai', inputTokens: 50, outputTokens: 10 });
    await db.addUsage(pool, inst, { kind: 'fallback' });
    const usage = await db.getMonthlyUsage(pool, inst);
    expect(usage).toMatchObject({ digestsSent: 2, fallbackSent: 1, inputTokens: 150, outputTokens: 50 });
    expect(usage.month).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe('installations', () => {
  test('deleting an installation purges all of its data', async () => {
    const inst = await newInstallation();
    await db.addMember(pool, inst, 42);
    await db.upsertMapping(pool, inst, { repo: 'acme/site', clientName: 'J', clientEmail: 'j@acme.test' });
    await db.claimDelivery(pool, { deliveryId: 'purge-1', installationId: inst, repo: 'acme/site' });
    await db.addUsage(pool, inst, { kind: 'ai', inputTokens: 1, outputTokens: 1 });

    await db.deleteInstallation(pool, inst);
    for (const table of ['installation_members', 'client_mappings', 'deliveries', 'usage']) {
      const { rowCount } = await pool.query(`SELECT 1 FROM ${table} WHERE installation_id = $1`, [inst]);
      expect({ table, rowCount }).toEqual({ table, rowCount: 0 });
    }
  });

  test('syncMemberships replaces a user\'s memberships with what GitHub reports', async () => {
    const keep = await newInstallation('keep');
    const drop = await newInstallation('drop');
    await db.addMember(pool, drop, 7);
    await db.syncMemberships(pool, 7, [{ id: keep, accountLogin: 'keep', accountType: 'User' }]);
    expect(await db.isMember(pool, keep, 7)).toBe(true);
    expect(await db.isMember(pool, drop, 7)).toBe(false);
  });
});