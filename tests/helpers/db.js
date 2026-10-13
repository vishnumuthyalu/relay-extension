const crypto = require('crypto');
const { createPool } = require('../../lib/db/pool');
const { migrate } = require('../../lib/db/migrate');

// A fresh, fully migrated schema per test file, so suites can run in
// parallel against one database without seeing each other's rows.
async function createTestDb() {
  const url = process.env.TEST_DATABASE_URL;
  const schema = `test_${crypto.randomBytes(6).toString('hex')}`;

  const admin = createPool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);

  const pool = createPool({ connectionString: url, max: 5, options: `-c search_path=${schema}` });
  await migrate(pool);

  return {
    pool,
    async destroy() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

module.exports = { createTestDb };