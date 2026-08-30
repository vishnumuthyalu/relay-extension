const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function openDb(filePath) {
  const dbPath = filePath || path.join(__dirname, '..', 'data', 'relay.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
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
  `);
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

function isDuplicateDelivery(db, deliveryId) {
  return !!db.prepare('SELECT 1 FROM processed_deliveries WHERE delivery_id = ?').get(deliveryId);
}

function markDeliveryProcessed(db, deliveryId, repo) {
  db.prepare('INSERT OR IGNORE INTO processed_deliveries (delivery_id, repo) VALUES (?, ?)').run(deliveryId, repo);
}

module.exports = { openDb, upsertClient, getClient, isDuplicateDelivery, markDeliveryProcessed };