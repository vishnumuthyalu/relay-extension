const crypto = require('crypto');

// Synchronizer-token CSRF protection for the server-rendered forms (OAuth
// consent and the dashboard). The session cookie is already SameSite=Lax,
// which stops cross-site POSTs from carrying it; this is the second layer.

function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('base64url');
  return req.session.csrf;
}

function validCsrf(req) {
  const expected = req.session?.csrf;
  const provided = req.body?._csrf;
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { csrfToken, validCsrf };
