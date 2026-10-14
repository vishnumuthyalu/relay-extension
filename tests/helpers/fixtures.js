const crypto = require('crypto');
const { loadConfig } = require('../../lib/config');
const { createLinks } = require('../../lib/links');
const { createPipeline } = require('../../lib/pipeline');

const WEBHOOK_SECRET = 'test-webhook-secret';

function testConfig(overrides = {}) {
  return loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    PUBLIC_URL: 'https://relay.test',
    SESSION_SECRET: 'x'.repeat(40),
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_APP_SLUG: 'relay-test',
    GITHUB_CLIENT_ID: 'client-id',
    GITHUB_CLIENT_SECRET: 'client-secret',
    RESEND_API_KEY: 'resend-key',
    FROM_EMAIL: 'relay@relay.test',
    ANTHROPIC_API_KEY: 'anthropic-key',
    DIGEST_MONTHLY_CAP: '3',
    ...overrides,
  });
}

const goodSummary = {
  headline: 'Checkout now remembers saved cards',
  summary: 'Returning customers can pay with a saved card in one tap.',
  highlights: ['Saved cards at checkout'],
  risk_notes: null,
};

// The real pipeline with Claude and Resend replaced by mocks.
function testPipeline(config = testConfig()) {
  const links = createLinks({ secret: config.sessionSecret, publicUrl: config.publicUrl });
  const summarize = jest.fn().mockResolvedValue({
    summary: goodSummary,
    model: 'claude-haiku-4-5',
    usage: { inputTokens: 100, outputTokens: 50 },
  });
  const send = jest.fn().mockResolvedValue({ id: 'email_1' });
  const pipeline = createPipeline({ config, links, summarize, send });
  return { pipeline, links, summarize, send, config };
}

function sign(raw, secret = WEBHOOK_SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

module.exports = { testConfig, testPipeline, goodSummary, sign, WEBHOOK_SECRET };