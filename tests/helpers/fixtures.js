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

// A stand-in for lib/github.js: sign-in always succeeds as `user`, who can
// access `installations`.
function fakeGithub(user, installations) {
  return {
    installUrl: 'https://github.com/apps/relay-test/installations/new',
    authorizeUrl: ({ state }) => `https://github.test/login/oauth/authorize?state=${state}`,
    exchangeCode: jest.fn().mockResolvedValue('user-token'),
    getUser: jest.fn().mockResolvedValue(user),
    listInstallations: jest.fn().mockResolvedValue(installations),
  };
}

// Runs /auth/login → /auth/callback on a supertest agent (which keeps the
// session cookie) and returns the agent, signed in.
async function signIn(agent) {
  const login = await agent.get('/auth/login');
  const state = new URL(login.headers.location).searchParams.get('state');
  const callback = await agent.get(`/auth/callback?code=abc&state=${state}`);
  if (callback.status !== 302) throw new Error(`sign-in failed: ${callback.status}`);
  return agent;
}

// Pulls a hidden input's value out of a rendered form.
function formValue(html, name) {
  const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  return match ? match[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'") : undefined;
}

module.exports = { testConfig, testPipeline, goodSummary, sign, WEBHOOK_SECRET, fakeGithub, signIn, formValue };
