const crypto = require('crypto');

// Minimal HS256 JWTs for MCP access tokens. Relay both issues and checks
// them, so a shared secret (derived from SESSION_SECRET) is enough and no
// key distribution is needed. Only HS256 is accepted on verify, so a token
// claiming "alg": "none" or another algorithm is rejected.

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

function deriveKey(secret) {
  return crypto.createHmac('sha256', secret).update('relay:mcp-access-token:v1').digest();
}

function signJwt(payload, key) {
  const input = `${b64({ alg: 'HS256', typ: 'at+jwt' })}.${b64(payload)}`;
  const signature = crypto.createHmac('sha256', key).update(input).digest('base64url');
  return `${input}.${signature}`;
}

// Returns the payload if the signature is valid, otherwise null. Callers
// still check exp, iss and aud.
function verifyJwt(token, key) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  let parsedHeader;
  try {
    parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsedHeader.alg !== 'HS256') return null;

  const expected = crypto.createHmac('sha256', key).update(`${header}.${payload}`).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;

  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = { deriveKey, signJwt, verifyJwt };
