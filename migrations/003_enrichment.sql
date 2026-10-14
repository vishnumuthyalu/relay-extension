-- Richer summaries (Phase 5). Both are off until a tenant turns them on.

-- Pull GitHub context (merged PR titles and descriptions, change stats)
-- into each summary. Needs the app's "Pull requests: read" permission.
ALTER TABLE installations ADD COLUMN enrichment_enabled BOOLEAN NOT NULL DEFAULT false;

-- A tenant's ticket tracker, reached through its remote MCP server by
-- Anthropic's MCP connector. The token is AES-256-GCM encrypted with
-- INTEGRATIONS_KEY; Relay never shows it again after it is saved.
CREATE TABLE integrations (
  installation_id  BIGINT PRIMARY KEY REFERENCES installations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,                 -- shown in the dashboard, e.g. 'Linear'
  mcp_url          TEXT NOT NULL,                 -- the tracker's remote MCP endpoint (https)
  token_encrypted  TEXT NOT NULL,
  allowed_tools    TEXT[] NOT NULL,               -- read-only tools Claude may call
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);