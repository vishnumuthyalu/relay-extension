const crypto = require('crypto');

// Calls GitHub as the Relay GitHub App, on behalf of one installation.
//
// 1. Sign a short-lived JWT (RS256) with the app's private key.
// 2. Exchange it for an installation access token (valid about an hour),
//    scoped to that installation's repositories and the app's permissions.
// Tokens are cached in memory until five minutes before they expire.

const API = 'https://api.github.com';

function createAppJwt({ appId, privateKey, now = () => Date.now() }) {
  const iat = Math.floor(now() / 1000) - 60; // allow for clock drift
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat, exp: iat + 9 * 60, iss: String(appId) })).toString('base64url');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function createGithubApp({ appId, privateKey, fetchImpl = fetch, now = () => Date.now() }) {
  const cache = new Map();

  async function installationToken(installationId) {
    const cached = cache.get(installationId);
    if (cached && cached.expiresAt - 5 * 60 * 1000 > now()) return cached.token;

    const res = await fetchImpl(`${API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${createAppJwt({ appId, privateKey, now })}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'relay',
      },
    });
    if (!res.ok) throw new Error(`GitHub installation token request failed: ${res.status}`);
    const { token, expires_at: expiresAt } = await res.json();
    cache.set(installationId, { token, expiresAt: Date.parse(expiresAt) });
    return token;
  }

  // GET a REST path as the installation. Returns parsed JSON.
  async function get(installationId, path) {
    const res = await fetchImpl(`${API}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${await installationToken(installationId)}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'relay',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status}`);
    return res.json();
  }

  return { installationToken, get };
}

module.exports = { createGithubApp, createAppJwt };