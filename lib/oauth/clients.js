const crypto = require('crypto');
const net = require('net');

// Who an OAuth client is and where it may send users back to.
//
// MCP clients identify themselves one of two ways:
//  - Client ID Metadata Documents (preferred by the 2026-07-28 MCP spec):
//    client_id is an HTTPS URL serving JSON with the client's name and
//    redirect_uris. Relay fetches it when the client starts authorization.
//  - Dynamic Client Registration (RFC 7591, deprecated but still common):
//    the client POSTs /oauth/register first and gets a random client_id.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const METADATA_TIMEOUT_MS = 5000;
const METADATA_MAX_BYTES = 64 * 1024;
const METADATA_CACHE_MS = 5 * 60 * 1000;

function isLoopbackHttp(url) {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

// Allowed redirect URIs: https, http on loopback (RFC 8252 native apps),
// or a native app's private-use scheme. Never fragments, javascript: or data:.
function isAllowedRedirectUri(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (['javascript:', 'data:', 'file:', 'vbscript:'].includes(url.protocol)) return false;
  if (url.protocol === 'http:') return isLoopbackHttp(url);
  return true;
}

// Exact match, except that loopback redirects may use any port: native
// clients pick a free port at runtime (RFC 8252 section 7.3).
function redirectMatches(registered, requested) {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    return isLoopbackHttp(a) && isLoopbackHttp(b)
      && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

// A client metadata URL must be HTTPS on a public hostname, so Relay
// can't be pointed at its own network. This blocks the obvious cases; for
// a production service also resolve the name and refuse private addresses.
function isFetchableMetadataUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.hash || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  return url.pathname !== '/';
}

function createClientRegistry({ pool, fetchImpl = fetch, now = () => Date.now() }) {
  const cache = new Map();

  async function fetchMetadataDocument(clientId) {
    const cached = cache.get(clientId);
    if (cached && cached.expires > now()) return cached.client;

    const res = await fetchImpl(clientId, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (Buffer.byteLength(text) > METADATA_MAX_BYTES) return null;

    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      return null;
    }
    // The document must claim the URL it was fetched from.
    if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) return null;
    if (!doc.redirect_uris.every(isAllowedRedirectUri)) return null;

    const client = {
      clientId,
      clientName: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 100) : new URL(clientId).hostname,
      redirectUris: doc.redirect_uris,
    };
    cache.set(clientId, { client, expires: now() + METADATA_CACHE_MS });
    return client;
  }

  return {
    // Returns { clientId, clientName, redirectUris } or null if unknown.
    async resolve(clientId) {
      if (typeof clientId !== 'string' || !clientId) return null;
      if (clientId.startsWith('https://')) {
        if (!isFetchableMetadataUrl(clientId)) return null;
        try {
          return await fetchMetadataDocument(clientId);
        } catch {
          return null;
        }
      }
      const { rows } = await pool.query('SELECT * FROM oauth_clients WHERE client_id = $1', [clientId]);
      if (!rows[0]) return null;
      return { clientId, clientName: rows[0].client_name || 'MCP client', redirectUris: rows[0].redirect_uris };
    },

    // RFC 7591 registration for public clients. Returns the stored client
    // or throws with an OAuth error code.
    async register({ client_name: clientName, redirect_uris: redirectUris }) {
      if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10
        || !redirectUris.every((u) => typeof u === 'string' && isAllowedRedirectUri(u))) {
        const err = new Error('redirect_uris must be https, loopback http, or a private-use scheme');
        err.oauthError = 'invalid_redirect_uri';
        throw err;
      }
      const clientId = `relay_${crypto.randomBytes(16).toString('hex')}`;
      const name = typeof clientName === 'string' ? clientName.slice(0, 100) : null;
      await pool.query(
        'INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)',
        [clientId, name, redirectUris]
      );
      return { clientId, clientName: name, redirectUris };
    },
  };
}

module.exports = { createClientRegistry, redirectMatches, isAllowedRedirectUri, isFetchableMetadataUrl };
