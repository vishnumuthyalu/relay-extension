// Runs before every test file (see jest.config.js). Gives server.js the
// env it requires and keeps tests off the real data/relay.sqlite file.
process.env.GITHUB_WEBHOOK_SECRET ||= 'test-webhook-secret';
process.env.ANTHROPIC_API_KEY ||= 'test-anthropic-key';
process.env.RESEND_API_KEY ||= 'test-resend-key';
process.env.FROM_EMAIL ||= 'relay@example.com';
process.env.CONFIG_API_KEY ||= 'test-config-key';
process.env.DB_PATH = ':memory:';
