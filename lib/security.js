const crypto = require('crypto');

// Implements spec/webhook-contract.md, "Signature verification".
// rawBody MUST be the exact bytes GitHub signed — see server.js for
// how express.json({ verify }) captures it before parsing.
function verifyGithubSignature(rawBody, signatureHeader, secret) {
  if (!rawBody || !signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Middleware: rejects unsigned or badly signed webhook deliveries before
// any other middleware (including the OpenAPI validator) sees the body,
// so unauthenticated callers never receive schema error details.
function requireGithubSignature(secret) {
  return function (req, res, next) {
    if (!verifyGithubSignature(req.rawBody, req.get('X-Hub-Signature-256'), secret)) {
      return res.status(401).json({ error: 'invalid signature' });
    }
    next();
  };
}

// Middleware: guards /config and /test per the openapi.yaml "configKey"
// securityScheme (X-Config-Key header, apiKey type).
function requireConfigKey(configKey) {
  return function (req, res, next) {
    const provided = req.get('X-Config-Key') || '';
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(configKey || ''));
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) return res.status(401).json({ error: 'invalid or missing X-Config-Key' });
    next();
  };
}

module.exports = { verifyGithubSignature, requireGithubSignature, requireConfigKey };
