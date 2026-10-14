const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');
// Any constant works; it just has to be the same in every process so the
// web and worker processes never run migrations at the same time.
const LOCK_ID = 727274;

// Applies every migrations/*.sql file not yet recorded in
// schema_migrations, in filename order, each in its own transaction.
// Never edit a migration that has shipped; add a new numbered file.
async function migrate(pool, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const pending = fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && !applied.has(f)).sort();

    for (const name of pending) {
      const sql = fs.readFileSync(path.join(dir, name), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
        log(`applied ${name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${name} failed: ${err.message}`, { cause: err });
      }
    }
    return pending;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  require('dotenv/config');
  const { createPool } = require('./pool');
  const pool = createPool();
  migrate(pool, { log: (m) => console.log(m) })
    .then((names) => console.log(names.length ? `done (${names.length})` : 'up to date'))
    .catch((err) => { console.error(err.message); process.exitCode = 1; })
    .finally(() => pool.end());
}