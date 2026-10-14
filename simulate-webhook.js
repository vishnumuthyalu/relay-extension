// Local test tool: sends a signed GitHub App "push" delivery to a running
// Relay (npm run dev, or docker compose up), so you can exercise the full
// path (signature → claim → queue → worker → email) without a real push.
//
// Before running:
//   1. The installation exists (install the app once, or let this script's
//      first push create it), and SIM_REPO is mapped to a client who has
//      confirmed (map it through the API, the dashboard or the MCP tools,
//      then click the confirmation email).
//   2. Set GITHUB_WEBHOOK_SECRET, SIM_INSTALLATION_ID and SIM_REPO in .env.
//
// Usage: node simulate-webhook.js
require('dotenv/config');
const crypto = require('crypto');

const BASE_URL = process.env.SIM_BASE_URL || 'http://localhost:3000';
const REPO = process.env.SIM_REPO || 'acme/test-repo';
const INSTALLATION_ID = Number(process.env.SIM_INSTALLATION_ID);
const SECRET = process.env.GITHUB_WEBHOOK_SECRET;

if (!SECRET || !Number.isSafeInteger(INSTALLATION_ID)) {
  console.error('Set GITHUB_WEBHOOK_SECRET and SIM_INSTALLATION_ID in .env first.');
  process.exit(1);
}

const [owner] = REPO.split('/');
const payload = {
  ref: 'refs/heads/main',
  installation: { id: INSTALLATION_ID },
  repository: { full_name: REPO, default_branch: 'main', owner: { login: owner, type: 'User' } },
  pusher: { name: 'octocat' },
  commits: [
    {
      id: 'a1b2c3d',
      message: 'Fix off-by-one bug in pagination',
      url: `https://github.com/${REPO}/commit/a1b2c3d`,
      author: { name: 'octocat' },
    },
    {
      id: 'e4f5a6b',
      message: 'Add saved cards to checkout',
      url: `https://github.com/${REPO}/commit/e4f5a6b`,
      author: { name: 'octocat' },
    },
  ],
};

(async () => {
  const raw = Buffer.from(JSON.stringify(payload));
  const deliveryId = crypto.randomUUID();
  const res = await fetch(`${BASE_URL}/webhook/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex'),
      'X-GitHub-Event': 'push',
      'X-GitHub-Delivery': deliveryId,
    },
    body: raw,
  });
  console.log(`POST /webhook/github -> ${res.status}`, await res.json().catch(() => ({})));
  console.log(`delivery id: ${deliveryId}`);
  console.log('"accepted" means the worker will send the digest; watch the worker logs.');
  console.log('"filtered" usually means the repo is unmapped or the client has not confirmed yet.');
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});