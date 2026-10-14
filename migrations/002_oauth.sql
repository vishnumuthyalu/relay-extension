-- OAuth 2.1 authorization server state for the remote MCP endpoint.
-- Codes and refresh tokens are stored only as SHA-256 hashes, so a
-- database leak doesn't hand out usable credentials.

-- Clients that registered with Dynamic Client Registration (RFC 7591).
-- Clients using Client ID Metadata Documents aren't stored: their
-- client_id is an HTTPS URL that Relay fetches at authorization time.
CREATE TABLE oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT,
  redirect_uris TEXT[] NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  github_user_id BIGINT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,          -- PKCE S256
  scopes         TEXT[] NOT NULL,
  resource       TEXT NOT NULL,          -- RFC 8707 audience the token will carry
  expires_at     TIMESTAMPTZ NOT NULL
);

CREATE TABLE oauth_refresh_tokens (
  token_hash     TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  github_user_id BIGINT NOT NULL,
  scopes         TEXT[] NOT NULL,
  resource       TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX oauth_refresh_tokens_user ON oauth_refresh_tokens (github_user_id);
