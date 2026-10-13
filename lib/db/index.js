// Data access for Relay. Every function that touches tenant data takes
// installationId and filters by it, so one tenant can never read or
// change another's rows by accident. `db` is a pg Pool (or a client
// inside a transaction).

// A 'processing' claim older than this is treated as abandoned (the
// worker died) and can be taken over by a GitHub redelivery. Keep it
// longer than the queue's total retry window.
const STALE_CLAIM_MINUTES = 30;

// ---- installations and members --------------------------------------

async function upsertInstallation(db, { id, accountLogin, accountType }) {
  await db.query(
    `INSERT INTO installations (id, account_login, account_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET
       account_login = EXCLUDED.account_login,
       account_type = EXCLUDED.account_type,
       updated_at = now()`,
    [id, accountLogin, accountType]
  );
}

async function getInstallation(db, id) {
  const { rows } = await db.query('SELECT * FROM installations WHERE id = $1', [id]);
  return rows[0] || null;
}

// Uninstalling the app removes everything for that tenant (ON DELETE CASCADE).
async function deleteInstallation(db, id) {
  await db.query('DELETE FROM installations WHERE id = $1', [id]);
}

async function setInstallationSuspended(db, id, suspended) {
  await db.query(
    'UPDATE installations SET suspended_at = $2, updated_at = now() WHERE id = $1',
    [id, suspended ? new Date() : null]
  );
}

async function addMember(db, installationId, githubUserId) {
  await db.query(
    `INSERT INTO installation_members (installation_id, github_user_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [installationId, githubUserId]
  );
}

async function isMember(db, installationId, githubUserId) {
  const { rowCount } = await db.query(
    'SELECT 1 FROM installation_members WHERE installation_id = $1 AND github_user_id = $2',
    [installationId, githubUserId]
  );
  return rowCount === 1;
}

async function upsertUser(db, { githubUserId, login }) {
  await db.query(
    `INSERT INTO users (github_user_id, login) VALUES ($1, $2)
     ON CONFLICT (github_user_id) DO UPDATE SET login = EXCLUDED.login, last_login_at = now()`,
    [githubUserId, login]
  );
}

// Replaces the user's memberships with exactly the installations GitHub
// says they can access right now (the source of truth), in one transaction.
async function syncMemberships(pool, githubUserId, installations) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const inst of installations) await upsertInstallation(client, inst);
    await client.query('DELETE FROM installation_members WHERE github_user_id = $1', [githubUserId]);
    for (const inst of installations) await addMember(client, inst.id, githubUserId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listUserInstallations(db, githubUserId) {
  const { rows } = await db.query(
    `SELECT i.* FROM installations i
     JOIN installation_members m ON m.installation_id = i.id
     WHERE m.github_user_id = $1
     ORDER BY i.account_login`,
    [githubUserId]
  );
  return rows;
}

// ---- client mappings -------------------------------------------------

function mappingStatus(row) {
  if (row.unsubscribed_at) return 'unsubscribed';
  if (!row.confirmed_at) return 'pending';
  return 'active';
}

function toMapping(row) {
  return {
    repo: row.repo,
    clientName: row.client_name,
    clientEmail: row.client_email,
    branch: row.branch,
    status: mappingStatus(row),
    updatedAt: row.updated_at.toISOString(),
  };
}

// Creates or updates a mapping. A new address must confirm again, so a
// changed email resets confirmed_at and unsubscribed_at. Returns the
// mapping and whether a confirmation email is needed.
async function upsertMapping(db, installationId, { repo, clientName, clientEmail, branch = null }) {
  const { rows } = await db.query(
    `INSERT INTO client_mappings (installation_id, repo, client_name, client_email, branch)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (installation_id, repo) DO UPDATE SET
       client_name = EXCLUDED.client_name,
       branch = EXCLUDED.branch,
       confirmed_at = CASE WHEN client_mappings.client_email = EXCLUDED.client_email
                           THEN client_mappings.confirmed_at END,
       unsubscribed_at = CASE WHEN client_mappings.client_email = EXCLUDED.client_email
                              THEN client_mappings.unsubscribed_at END,
       client_email = EXCLUDED.client_email,
       updated_at = now()
     RETURNING *`,
    [installationId, repo, clientName, clientEmail, branch]
  );
  const row = rows[0];
  return { mapping: toMapping(row), needsConfirmation: !row.confirmed_at && !row.unsubscribed_at };
}

async function getMappingRow(db, installationId, repo) {
  const { rows } = await db.query(
    'SELECT * FROM client_mappings WHERE installation_id = $1 AND repo = $2',
    [installationId, repo]
  );
  return rows[0] || null;
}

async function getMapping(db, installationId, repo) {
  const row = await getMappingRow(db, installationId, repo);
  return row ? toMapping(row) : null;
}

async function listMappings(db, installationId) {
  const { rows } = await db.query(
    'SELECT * FROM client_mappings WHERE installation_id = $1 ORDER BY repo',
    [installationId]
  );
  return rows.map(toMapping);
}

async function deleteMapping(db, installationId, repo) {
  const { rowCount } = await db.query(
    'DELETE FROM client_mappings WHERE installation_id = $1 AND repo = $2',
    [installationId, repo]
  );
  return rowCount === 1;
}

// Confirm/unsubscribe only apply if the address in the signed link is
// still the mapped address; a link for an old address does nothing.
async function confirmMapping(db, installationId, repo, email) {
  const { rowCount } = await db.query(
    `UPDATE client_mappings SET confirmed_at = COALESCE(confirmed_at, now()), unsubscribed_at = NULL, updated_at = now()
     WHERE installation_id = $1 AND repo = $2 AND client_email = $3`,
    [installationId, repo, email]
  );
  return rowCount === 1;
}

async function unsubscribeMapping(db, installationId, repo, email) {
  const { rowCount } = await db.query(
    `UPDATE client_mappings SET unsubscribed_at = COALESCE(unsubscribed_at, now()), updated_at = now()
     WHERE installation_id = $1 AND repo = $2 AND client_email = $3`,
    [installationId, repo, email]
  );
  return rowCount === 1;
}

// ---- deliveries --------------------------------------------------------

// Atomically claims a delivery. Exactly one caller gets true; the INSERT
// is the lock. A stale 'processing' claim can be taken over.
async function claimDelivery(db, { deliveryId, installationId, repo }) {
  const { rowCount } = await db.query(
    `INSERT INTO deliveries (delivery_id, installation_id, repo, status)
     VALUES ($1, $2, $3, 'processing')
     ON CONFLICT (delivery_id) DO UPDATE SET claimed_at = now()
     WHERE deliveries.status = 'processing'
       AND deliveries.claimed_at < now() - make_interval(mins => $4)`,
    [deliveryId, installationId, repo, STALE_CLAIM_MINUTES]
  );
  return rowCount === 1;
}

async function completeDelivery(db, deliveryId, outcome) {
  await db.query(
    `UPDATE deliveries SET status = 'done', outcome = $2, completed_at = now() WHERE delivery_id = $1`,
    [deliveryId, outcome]
  );
}

// Lets a GitHub redelivery retry a delivery whose processing failed.
async function releaseDelivery(db, deliveryId) {
  await db.query(`DELETE FROM deliveries WHERE delivery_id = $1 AND status = 'processing'`, [deliveryId]);
}

// ---- digests -----------------------------------------------------------

async function recordDigest(db, installationId, { deliveryId, repo, recipient, summary, commitCount, model, kind }) {
  await db.query(
    `INSERT INTO digests (delivery_id, installation_id, repo, recipient, headline, summary, commit_count, model, kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (delivery_id) DO NOTHING`,
    [deliveryId, installationId, repo, recipient, summary.headline, summary, commitCount, model, kind]
  );
}

function toDigest(row) {
  return {
    deliveryId: row.delivery_id,
    repo: row.repo,
    recipient: row.recipient,
    headline: row.headline,
    summary: row.summary,
    commitCount: row.commit_count,
    model: row.model,
    kind: row.kind,
    sentAt: row.sent_at.toISOString(),
  };
}

async function listDigests(db, installationId, { repo, limit = 10 } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM digests
     WHERE installation_id = $1 AND ($2::text IS NULL OR repo = $2)
     ORDER BY sent_at DESC, delivery_id DESC
     LIMIT $3`,
    [installationId, repo ?? null, limit]
  );
  return rows.map(toDigest);
}

async function getDigest(db, installationId, deliveryId) {
  const { rows } = await db.query(
    'SELECT * FROM digests WHERE installation_id = $1 AND delivery_id = $2',
    [installationId, deliveryId]
  );
  return rows[0] ? toDigest(rows[0]) : null;
}

// ---- usage ---------------------------------------------------------------

const CURRENT_MONTH = `date_trunc('month', now() AT TIME ZONE 'UTC')::date`;

async function getMonthlyUsage(db, installationId) {
  // LEFT JOIN so a month with no digests yet still returns zeros.
  const { rows } = await db.query(
    `SELECT to_char(m.month, 'YYYY-MM') AS label, u.digests_sent, u.fallback_sent, u.input_tokens, u.output_tokens
     FROM (SELECT ${CURRENT_MONTH} AS month) m
     LEFT JOIN usage u ON u.installation_id = $1 AND u.month = m.month`,
    [installationId]
  );
  const row = rows[0];
  return {
    month: row.label,
    digestsSent: row.digests_sent ?? 0,
    fallbackSent: row.fallback_sent ?? 0,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
  };
}

async function addUsage(db, installationId, { kind, inputTokens = 0, outputTokens = 0 }) {
  const ai = kind === 'ai' ? 1 : 0;
  await db.query(
    `INSERT INTO usage (installation_id, month, digests_sent, fallback_sent, input_tokens, output_tokens)
     VALUES ($1, ${CURRENT_MONTH}, $2, $3, $4, $5)
     ON CONFLICT (installation_id, month) DO UPDATE SET
       digests_sent = usage.digests_sent + EXCLUDED.digests_sent,
       fallback_sent = usage.fallback_sent + EXCLUDED.fallback_sent,
       input_tokens = usage.input_tokens + EXCLUDED.input_tokens,
       output_tokens = usage.output_tokens + EXCLUDED.output_tokens`,
    [installationId, ai, 1 - ai, inputTokens, outputTokens]
  );
}

module.exports = {
  STALE_CLAIM_MINUTES,
  upsertInstallation,
  getInstallation,
  deleteInstallation,
  setInstallationSuspended,
  addMember,
  isMember,
  upsertUser,
  syncMemberships,
  listUserInstallations,
  upsertMapping,
  getMappingRow,
  getMapping,
  listMappings,
  deleteMapping,
  confirmMapping,
  unsubscribeMapping,
  claimDelivery,
  completeDelivery,
  releaseDelivery,
  recordDigest,
  listDigests,
  getDigest,
  getMonthlyUsage,
  addUsage,
};