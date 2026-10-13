const {
  openDb, claimDelivery, completeDelivery, releaseDelivery, recordDigest, listDigests, getDigest,
} = require('../lib/db');

describe('delivery claims', () => {
  let db;
  beforeEach(() => { db = openDb(':memory:'); });

  test('only the first claim wins', () => {
    expect(claimDelivery(db, 'd1', 'acme/site')).toBe(true);
    expect(claimDelivery(db, 'd1', 'acme/site')).toBe(false);
  });

  test('a completed delivery stays claimed', () => {
    claimDelivery(db, 'd1', 'acme/site');
    completeDelivery(db, 'd1');
    expect(claimDelivery(db, 'd1', 'acme/site')).toBe(false);
  });

  test('a released delivery can be claimed again', () => {
    claimDelivery(db, 'd1', 'acme/site');
    releaseDelivery(db, 'd1');
    expect(claimDelivery(db, 'd1', 'acme/site')).toBe(true);
  });

  test('a stale processing claim can be taken over', () => {
    claimDelivery(db, 'd1', 'acme/site');
    db.prepare(`UPDATE processed_deliveries SET processed_at = datetime('now', '-1 hour')`).run();
    expect(claimDelivery(db, 'd1', 'acme/site')).toBe(true);
  });

  test('migrations record the schema version', () => {
    expect(db.prepare('PRAGMA user_version').get().user_version).toBe(3);
  });
  
describe('digests', () => {
  let db;
  beforeEach(() => { db = openDb(':memory:'); });

  const summary = { headline: 'Checkout fixed', summary: 'x'.repeat(30), highlights: ['Fixed checkout'], risk_notes: null };
  const record = (deliveryId, repo) =>
    recordDigest(db, { deliveryId, repo, recipient: 'c@acme.test', summary, commitCount: 2, model: 'claude-haiku-4-5' });

  test('records and reads back a digest', () => {
    record('d1', 'acme/site');
    expect(getDigest(db, 'd1')).toMatchObject({ deliveryId: 'd1', repo: 'acme/site', summary, commitCount: 2 });
    expect(getDigest(db, 'missing')).toBeNull();
  });

  test('lists newest first and filters by repo', () => {
    record('d1', 'acme/site');
    record('d2', 'acme/other');
    record('d3', 'acme/site');
    expect(listDigests(db).map((d) => d.deliveryId)).toEqual(['d3', 'd2', 'd1']);
    expect(listDigests(db, { repo: 'acme/site', limit: 1 }).map((d) => d.deliveryId)).toEqual(['d3']);
  });
});
});
