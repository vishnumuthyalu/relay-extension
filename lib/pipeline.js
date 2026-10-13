const { summarizeWithClaude } = require('./claude');
const { renderEmailHtml, sendEmail } = require('./email');

// The work that happens after a push has been verified, claimed and
// matched to a client: summarize with Claude, then email the digest.
// Kept free of Express so the webhook, the MCP server and (later) a queue
// worker can all call it. Dependencies are injectable for tests.
function createPipeline({
  env = process.env,
  summarize = summarizeWithClaude,
  send = sendEmail,
} = {}) {
  async function processPush({ payload, client }) {
    const { repository, pusher, commits } = payload;
    const summary = await summarize({
      repo: repository.full_name,
      pusher: pusher.name,
      commits,
      totalCommits: commits.length,
      apiKey: env.ANTHROPIC_API_KEY,
    });

    await send({
      to: client.client_email,
      subject: summary.headline,
      html: renderEmailHtml({
        clientName: client.client_name,
        repo: repository.full_name,
        pusher: pusher.name,
        summary,
      }),
      apiKey: env.RESEND_API_KEY,
      fromEmail: env.FROM_EMAIL,
    });

    return { summary, recipient: client.client_email, commitCount: commits.length };
  }

  return { processPush };
}

module.exports = { createPipeline };
