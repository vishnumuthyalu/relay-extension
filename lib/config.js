// Reads and validates configuration once, at startup, so a missing secret
// crashes the process on boot instead of failing on the first request.

// Everything the web and worker processes need.
const REQUIRED = [
  'DATABASE_URL',
  'PUBLIC_URL',           // e.g. https://relay.example.com (no trailing slash)
  'SESSION_SECRET',       // 32+ random bytes; signs sessions and email links
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_APP_SLUG',      // the app's URL name: github.com/apps/<slug>
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'RESEND_API_KEY',
  'FROM_EMAIL',
];

// The local MCP server (mcp/stdio.js) never handles webhooks or sign-in,
// so it needs less.
const REQUIRED_FOR_MCP_STDIO = ['DATABASE_URL', 'PUBLIC_URL', 'SESSION_SECRET', 'RESEND_API_KEY', 'FROM_EMAIL'];

function loadConfig(env = process.env, { required: base = REQUIRED } = {}) {
  const claudeEnabled = env.CLAUDE_ENABLED !== 'false';
  const required = claudeEnabled ? [...base, 'ANTHROPIC_API_KEY'] : base;
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  if (env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');

  return {
    databaseUrl: env.DATABASE_URL,
    publicUrl: env.PUBLIC_URL.replace(/\/+$/, ''),
    sessionSecret: env.SESSION_SECRET,
    production: env.NODE_ENV === 'production',
    github: {
      // Optional: the app's id and private key let the worker read PRs for
      // richer summaries (Phase 5). Without them, that feature stays off.
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY ? env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
      webhookSecret: env.GITHUB_WEBHOOK_SECRET,
      appSlug: env.GITHUB_APP_SLUG,
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    },
    email: { resendApiKey: env.RESEND_API_KEY, from: env.FROM_EMAIL },
    // Optional: 32 random bytes, base64. Encrypts ticket-tracker tokens;
    // without it, tenants can't connect a tracker.
    integrationsKey: env.INTEGRATIONS_KEY,
    claude: {
      enabled: claudeEnabled,
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL,
      // Claude-written digests per installation per calendar month (UTC).
      // Past the cap, clients get a plain list of commit titles instead.
      monthlyCap: Number(env.DIGEST_MONTHLY_CAP || 100),
    },
  };
}

module.exports = { loadConfig, REQUIRED, REQUIRED_FOR_MCP_STDIO };