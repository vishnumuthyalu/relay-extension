// One-off local test tool: simulates a GitHub "push" webhook delivery
// against a locally running instance of this app (e.g. the Docker
// container from `docker run ... -p 3000:3000 ...`), so you can confirm
// the full pipeline (signature check -> dedup -> Claude summary -> email)
// without needing a real GitHub push.
//
// Usage:
//   1. Set SIM_CLIENT_EMAIL (and optionally SIM_REPO, SIM_BASE_URL) in .env.
//   2. node simulate-webhook.js
//
// Reads GITHUB_WEBHOOK_SECRET and CONFIG_API_KEY from .env in this
// directory (same values the running container was started with).

require('dotenv/config');
const crypto = require('crypto');

// ---- CONFIG: set these in .env ----
const BASE_URL = process.env.SIM_BASE_URL || 'http://localhost:3000';
const REPO = process.env.SIM_REPO || 'acme/test-repo'; // any owner/repo string, doesn't need to be real
// Resend's sandbox sender (onboarding@resend.dev) can only deliver to the
// address on your Resend account, so put that address here until you
// verify a sending domain.
const CLIENT_EMAIL = process.env.SIM_CLIENT_EMAIL;
const CLIENT_NAME = process.env.SIM_CLIENT_NAME || 'Test Client';
// -----------------------------

const CONFIG_API_KEY = process.env.CONFIG_API_KEY;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

if (!CONFIG_API_KEY || !GITHUB_WEBHOOK_SECRET || !CLIENT_EMAIL) {
  console.error('Missing CONFIG_API_KEY, GITHUB_WEBHOOK_SECRET or SIM_CLIENT_EMAIL — is .env present and loaded?');
  process.exit(1);
}

function sign(rawBody, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

async function upsertClientConfig() {
  const res = await fetch(`${BASE_URL}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Config-Key': CONFIG_API_KEY },
    body: JSON.stringify({ repo: REPO, clientEmail: CLIENT_EMAIL, clientName: CLIENT_NAME }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`[1/2] POST /config -> ${res.status}`, body);
  if (!res.ok) throw new Error('Could not map client — check CONFIG_API_KEY and that the server is running.');
}

async function sendFakePush() {
  const payload = {
    ref: 'refs/heads/main',
    repository: { full_name: REPO },
    pusher: { name: 'octocat' },
    commits: [
      {
        id: 'a1b2c3d',
        message: 'Fix off-by-one bug in pagination',
        url: `https://github.com/${REPO}/commit/a1b2c3d`,
        author: { name: 'octocat' },
      },
      {
        id: 'e4f5g6h',
        message: 'Add rate limiting to the config endpoint',
        url: `https://github.com/${REPO}/commit/e4f5g6h`,
        author: { name: 'octocat' },
      },
    ],
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = sign(rawBody, GITHUB_WEBHOOK_SECRET);
  const deliveryId = crypto.randomUUID();

  const res = await fetch(`${BASE_URL}/webhook/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Hub-Signature-256': signature,
      'X-GitHub-Event': 'push',
      'X-GitHub-Delivery': deliveryId,
    },
    body: rawBody,
  });
  const body = await res.json().catch(() => ({}));
  console.log(`[2/2] POST /webhook/github -> ${res.status}`, body);
  console.log(`      delivery id: ${deliveryId} (re-running this script sends a NEW delivery id each time,`);
  console.log('      so it will not be deduped — that only kicks in on a genuine GitHub retry.)');
}

(async () => {
  try {
    await upsertClientConfig();
    await sendFakePush();
    console.log('\nIf status was "accepted", check the inbox for', CLIENT_EMAIL, 'in a few seconds.');
  } catch (err) {
    console.error('\nFAILED:', err.message);
    process.exit(1);
  }
})();
