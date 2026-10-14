const crypto = require('crypto');
const { signJwt, verifyJwt } = require('./jwt');

// Authorization codes, access tokens and refresh tokens for the MCP
// endpoint. Codes live 60 seconds and work once; access tokens are
// one-hour JWTs bound to the MCP server's URL (RFC 8707 audience);
// refresh tokens live 30 days and rotate on every use.

const SCOPES = ['relay:read', 'relay:write', 'relay:send'];
const CODE_TTL_SECONDS = 60;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_DAYS = 30;

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

// PKCE S256: BASE64URL(SHA256(code_verifier)) must equal the challenge.
function pkceMatches(verifier, challenge) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const computed = Buffer.from(crypto.createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
}

// Requested scopes that Relay knows; asking for none means all of them.
function grantableScopes(requested) {
  const asked = String(requested || '').split(' ').filter(Boolean);
  const known = asked.filter((s) => SCOPES.includes(s));
  return asked.length === 0 ? [...SCOPES] : known;
}

function createTokenService({ pool, key, issuer, now = () => Date.now() }) {
  const nowSeconds = () => Math.floor(now() / 1000);

  function issueAccessToken({ githubUserId, clientId, scopes, resource }) {
    const iat = nowSeconds();
    return signJwt({
      iss: issuer,
      sub: String(githubUserId),
      aud: resource,
      client_id: clientId,
      scope: scopes.join(' '),
      iat,
      exp: iat + ACCESS_TOKEN_TTL_SECONDS,
      jti: crypto.randomUUID(),
    }, key);
  }

  async function issueRefreshToken(db, { githubUserId, clientId, scopes, resource }) {
    const token = randomToken();
    await db.query(
      `INSERT INTO oauth_refresh_tokens (token_hash, client_id, github_user_id, scopes, resource, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))`,
      [hash(token), clientId, githubUserId, scopes, resource, REFRESH_TOKEN_TTL_DAYS]
    );
    return token;
  }

  function tokenResponse(accessToken, refreshToken, scopes) {
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  return {
    async createCode({ clientId, githubUserId, redirectUri, codeChallenge, scopes, resource }) {
      const code = randomToken();
      // Tidy up expired codes as we go; they're useless anyway.
      await pool.query('DELETE FROM oauth_codes WHERE expires_at < now()');
      await pool.query(
        `INSERT INTO oauth_codes (code_hash, client_id, github_user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
        [hash(code), clientId, githubUserId, redirectUri, codeChallenge, scopes, resource, CODE_TTL_SECONDS]
      );
      return code;
    },

    // grant_type=authorization_code. Returns a token response or throws an
    // error carrying an OAuth error code.
    async exchangeCode({ code, clientId, redirectUri, codeVerifier, resource }) {
      // DELETE ... RETURNING makes the code single-use even under races.
      const { rows } = await pool.query(
        'DELETE FROM oauth_codes WHERE code_hash = $1 RETURNING *, expires_at < now() AS expired',
        [hash(String(code || ''))]
      );
      const row = rows[0];
      const fail = (message) => Object.assign(new Error(message), { oauthError: 'invalid_grant' });
      if (!row || row.expired) throw fail('authorization code is invalid or expired');
      if (row.client_id !== clientId) throw fail('code was issued to another client');
      if (row.redirect_uri !== redirectUri) throw fail('redirect_uri does not match the authorization request');
      if (!pkceMatches(codeVerifier, row.code_challenge)) throw fail('PKCE verification failed');
      if (resource && resource !== row.resource) throw fail('resource does not match the authorization request');

      const grant = { githubUserId: row.github_user_id, clientId, scopes: row.scopes, resource: row.resource };
      return tokenResponse(issueAccessToken(grant), await issueRefreshToken(pool, grant), grant.scopes);
    },

    // grant_type=refresh_token, with rotation: the old refresh token is
    // deleted in the same transaction that issues the new one.
    async refresh({ refreshToken, clientId, resource }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          'DELETE FROM oauth_refresh_tokens WHERE token_hash = $1 RETURNING *, expires_at < now() AS expired',
          [hash(String(refreshToken || ''))]
        );
        const row = rows[0];
        const fail = (message) => Object.assign(new Error(message), { oauthError: 'invalid_grant' });
        if (!row || row.expired) throw fail('refresh token is invalid or expired');
        if (row.client_id !== clientId) throw fail('refresh token was issued to another client');
        if (resource && resource !== row.resource) throw fail('resource does not match the original grant');

        const grant = { githubUserId: row.github_user_id, clientId, scopes: row.scopes, resource: row.resource };
        const next = await issueRefreshToken(client, grant);
        await client.query('COMMIT');
        return tokenResponse(issueAccessToken(grant), next, grant.scopes);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    // Checks an access token for one resource (the MCP server's URL).
    verifyAccessToken(token, { resource }) {
      const claims = verifyJwt(token, key);
      if (!claims || claims.iss !== issuer || claims.aud !== resource) return null;
      if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds()) return null;
      return claims;
    },
  };
}

module.exports = { createTokenService, pkceMatches, grantableScopes, SCOPES, ACCESS_TOKEN_TTL_SECONDS };
