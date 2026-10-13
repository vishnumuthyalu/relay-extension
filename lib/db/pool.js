const { Pool } = require('pg');

// node-postgres returns BIGINT as a string by default, because it can
// exceed Number.MAX_SAFE_INTEGER. GitHub ids and token counts stay well
// below 2^53, so parse them as numbers.
require('pg').types.setTypeParser(20, (value) => Number(value));

function createPool({ connectionString = process.env.DATABASE_URL, ...options } = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  return new Pool({ connectionString, max: 10, ...options });
}

module.exports = { createPool };