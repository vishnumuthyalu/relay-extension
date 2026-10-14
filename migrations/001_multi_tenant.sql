-- Relay multi-tenant schema. Every tenant table carries installation_id
-- and cascades from installations, so uninstalling the GitHub App removes
-- that tenant's data in one DELETE.

CREATE TABLE installations (
  id                      BIGINT PRIMARY KEY,          -- GitHub App installation id
  account_login           TEXT NOT NULL,
  account_type            TEXT NOT NULL,               -- 'User' or 'Organization'
  suspended_at            TIMESTAMPTZ,
  anthropic_key_encrypted TEXT,                        -- reserved for bring-your-own-key
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  github_user_id BIGINT PRIMARY KEY,
  login          TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who may manage which installation. Refreshed from GitHub on every
-- sign-in, and seeded with the installer when the app is installed.
CREATE TABLE installation_members (
  installation_id BIGINT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  github_user_id  BIGINT NOT NULL,
  PRIMARY KEY (installation_id, github_user_id)
);
CREATE INDEX installation_members_user ON installation_members (github_user_id);

CREATE TABLE client_mappings (
  installation_id BIGINT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  repo            TEXT NOT NULL,                       -- owner/repo
  client_name     TEXT NOT NULL,
  client_email    TEXT NOT NULL,
  branch          TEXT,                                -- NULL = the repo's default branch
  confirmed_at    TIMESTAMPTZ,                         -- digests are sent only once set
  unsubscribed_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, repo)
);

CREATE TABLE deliveries (
  delivery_id     TEXT PRIMARY KEY,                    -- X-GitHub-Delivery
  installation_id BIGINT REFERENCES installations(id) ON DELETE CASCADE,
  repo            TEXT,
  status          TEXT NOT NULL CHECK (status IN ('processing', 'done')),
  outcome         TEXT,                                -- e.g. 'sent', 'filtered:branch'
  claimed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE TABLE digests (
  delivery_id     TEXT PRIMARY KEY,
  installation_id BIGINT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  repo            TEXT NOT NULL,
  recipient       TEXT NOT NULL,
  headline        TEXT NOT NULL,
  summary         JSONB NOT NULL,
  commit_count    INTEGER NOT NULL,
  model           TEXT,                                -- NULL for fallback digests
  kind            TEXT NOT NULL CHECK (kind IN ('ai', 'fallback')),
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX digests_by_repo ON digests (installation_id, repo, sent_at DESC);
CREATE INDEX digests_by_time ON digests (installation_id, sent_at DESC);

CREATE TABLE usage (
  installation_id BIGINT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  month           DATE NOT NULL,                       -- first day of the month (UTC)
  digests_sent    INTEGER NOT NULL DEFAULT 0,          -- Claude-written digests
  fallback_sent   INTEGER NOT NULL DEFAULT 0,          -- plain digests sent over the cap
  input_tokens    BIGINT NOT NULL DEFAULT 0,
  output_tokens   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (installation_id, month)
);