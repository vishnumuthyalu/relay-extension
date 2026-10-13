const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Each entry runs once, in order. PRAGMA user_version records how many
// have been applied, so existing databases pick up new columns without
// anyone deleting relay.sqlite by hand. Never edit a migration that has
// shipped; add a new one instead.
const MIGRATIONS = [
  // 1: original schema
  `
  CREATE TABLE IF NOT EXISTS clients (
    repo TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    client_email TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS processed_deliveries (
    delivery_id TEXT PRIMARY KEY,
    repo TEXT,
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // 2: delivery lifecycle. Rows that existed before this migration were
  // fully handled, so they default to 'done'.
  `
  ALTER TABLE processed_deliveries ADD COLUMN status TEXT NOT NULL DEFAULT 'done';
  `,
    // 3: history of every digest that was emailed, for the MCP server
  `
  CREATE TABLE digests (
    delivery_id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    recipient TEXT NOT NULL,
    headline TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    commit_count INTEGER NOT NULL,
    model TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX digests_repo_sent_at ON digests (repo, sent_at DESC);
  `,
];

// A claim older than this is treated as abandoned (the process crashed
// mid-delivery) and can be taken over by a GitHub redelivery.
const STALE_CLAIM_MINUTES = 10;

function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

function openDb(filePath) {
  const dbPath = filePath || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'relay.sqlite');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  migrate(db);
  return db;
}

function upsertClient(db, { repo, clientName, clientEmail }) {
  db.prepare(`
    INSERT INTO clients (repo, client_name, client_email, updated_at)
    VALUES (@repo, @clientName, @clientEmail, datetime('now'))
    ON CONFLICT(repo) DO UPDATE SET
      client_name = excluded.client_name,
      client_email = excluded.client_email,
      updated_at = excluded.updated_at
  `).run({ repo, clientName, clientEmail });
  return getClient(db, repo);
}

function getClient(db, repo) {
  return db.prepare('SELECT * FROM clients WHERE repo = ?').get(repo) || null;
}

function listClients(db) {
  return db.prepare('SELECT * FROM clients ORDER BY repo').all();
}

// Returns true if a mapping was removed.
function deleteClient(db, repo) {
  return db.prepare('DELETE FROM clients WHERE repo = ?').run(repo).changes === 1;
}

// Atomically claims a delivery for processing. Returns true only for the
// one caller that wins; concurrent or repeated deliveries get false.
// The INSERT is the lock: SQLite serializes writes, so two requests can't
// both insert the same primary key. A 'processing' row older than
// STALE_CLAIM_MINUTES can be re-claimed so a crash doesn't block a
// redelivery forever.
function claimDelivery(db, deliveryId, repo) {
  const { changes } = db.prepare(`
    INSERT INTO processed_deliveries (delivery_id, repo, status, processed_at)
    VALUES (?, ?, 'processing', datetime('now'))
    ON CONFLICT(delivery_id) DO UPDATE SET processed_at = datetime('now')
    WHERE processed_deliveries.status = 'processing'
      AND processed_deliveries.processed_at < datetime('now', ?)
  `).run(deliveryId, repo, `-${STALE_CLAIM_MINUTES} minutes`);
  return changes === 1;
}

function completeDelivery(db, deliveryId) {
  db.prepare(`
    UPDATE processed_deliveries SET status = 'done', processed_at = datetime('now')
    WHERE delivery_id = ?
  `).run(deliveryId);
}

// Called when processing fails, so a manual redelivery from GitHub's
// "Recent Deliveries" page can try again.
function releaseDelivery(db, deliveryId) {
  db.prepare(`DELETE FROM processed_deliveries WHERE delivery_id = ? AND status = 'processing'`).run(deliveryId);
}

function recordDigest(db, { deliveryId, repo, recipient, summary, commitCount, model }) {
  db.prepare(`
    INSERT OR REPLACE INTO digests (delivery_id, repo, recipient, headline, summary_json, commit_count, model, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(deliveryId, repo, recipient, summary.headline, JSON.stringify(summary), commitCount, model);
}

function rowToDigest(row) {
  return {
    deliveryId: row.delivery_id,
    repo: row.repo,
    recipient: row.recipient,
    headline: row.headline,
    summary: JSON.parse(row.summary_json),
    commitCount: row.commit_count,
    model: row.model,
    sentAt: row.sent_at,
  };
}

function listDigests(db, { repo, limit = 10 } = {}) {
  const rows = repo
    ? db.prepare('SELECT * FROM digests WHERE repo = ? ORDER BY sent_at DESC, rowid DESC LIMIT ?').all(repo, limit)
    : db.prepare('SELECT * FROM digests ORDER BY sent_at DESC, rowid DESC LIMIT ?').all(limit);
  return rows.map(rowToDigest);
}

function getDigest(db, deliveryId) {
  const row = db.prepare('SELECT * FROM digests WHERE delivery_id = ?').get(deliveryId);
  return row ? rowToDigest(row) : null;
}


module.exports = {
  openDb,
  upsertClient,
  getClient,
  listClients,
  deleteClient,
  recordDigest,
  listDigests,
  getDigest,
  claimDelivery,
  completeDelivery,
  releaseDelivery,
  STALE_CLAIM_MINUTES,
};
