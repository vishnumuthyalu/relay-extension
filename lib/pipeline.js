const { summarizeWithClaude, DEFAULT_MODEL } = require('./claude');
const { renderEmailHtml, sendEmail } = require('./email');

const TEST_SUMMARY = Object.freeze({
  headline: 'Test digest from Relay',
  summary: 'This is a sample update email generated on demand.',
  highlights: ['This is a sample highlight.'],
  risk_notes: null,
});

// Everything Relay does after a push (or a person) asks for an email:
// summarize with Claude, render, send. Kept free of Express so the
// webhook, the MCP server and (later) a queue worker can all call it.
// Dependencies are injectable for tests.
function createPipeline({
  env = process.env,
  summarize = summarizeWithClaude,
  send = sendEmail,
} = {}) {
  const model = () => env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  function summarizePush({ repo, pusher, commits }) {
    return summarize({
      repo,
      pusher,
      commits,
      totalCommits: commits.length,
      apiKey: env.ANTHROPIC_API_KEY,
      model: model(),
    });
  }

  function emailDigest({ client, repo, pusher, summary }) {
    return send({
      to: client.client_email,
      subject: summary.headline,
      html: renderEmailHtml({ clientName: client.client_name, repo, pusher, summary }),
      apiKey: env.RESEND_API_KEY,
      fromEmail: env.FROM_EMAIL,
    });
  }

  // A verified, claimed push for a mapped repo.
  async function processPush({ payload, client }) {
    const { repository, pusher, commits } = payload;
    const repo = repository.full_name;
    const summary = await summarizePush({ repo, pusher: pusher.name, commits });
    await emailDigest({ client, repo, pusher: pusher.name, summary });
    return { summary, recipient: client.client_email, commitCount: commits.length, model: model() };
  }

  // Dry run: what the client would receive for these commits. Sends nothing.
  function previewDigest({ repo, commits, pusher = 'preview' }) {
    return summarizePush({ repo, pusher, commits });
  }

  async function sendTestDigest({ repo, client }) {
    const summary = { ...TEST_SUMMARY, headline: `Test digest for ${repo}` };
    await emailDigest({ client, repo, pusher: 'test', summary });
    return { recipient: client.client_email };
  }

  // Re-send a stored digest to whoever is mapped to its repo now.
  async function resendDigest({ digest, client }) {
    await emailDigest({ client, repo: digest.repo, pusher: 'resend', summary: digest.summary });
    return { recipient: client.client_email };
  }

  return { processPush, previewDigest, sendTestDigest, resendDigest, model };
}

module.exports = { createPipeline };