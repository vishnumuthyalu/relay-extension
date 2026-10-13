const { openDb, claimDelivery, completeDelivery, releaseDelivery } = require('../lib/db');

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
    expect(db.prepare('PRAGMA user_version').get().user_version).toBe(2);
  });
});
