const { summarizeWithClaude, MAX_COMMITS_IN_PROMPT } = require('./claude');
const { renderEmailHtml, renderConfirmationHtml, unsubscribeHeaders, sendEmail } = require('./email');

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const firstLine = (message) => message.split('\n')[0].trim();

// Used past the monthly cap or when Claude is switched off: the client
// still hears about the push, as a plain list of commit titles. It
// satisfies the same summary schema as a Claude-written digest.
function fallbackSummary({ repo, commits, totalCommits = commits.length }) {
  const count = totalCommits === 1 ? '1 new update' : `${totalCommits} new updates`;
  return {
    headline: clip(`${count} on ${repo}`, 90),
    summary: 'Here are the latest changes the team shipped. A plain-English summary was not generated for this update.',
    highlights: commits.slice(0, 6).map((c) => clip(firstLine(c.message) || 'Untitled change', 160)),
    risk_notes: null,
  };
}

// Everything Relay does to turn commits into email. Kept free of Express
// and the queue, so the worker, the API and the MCP server share it.
// Dependencies are injectable for tests.
function createPipeline({ config, links, summarize = summarizeWithClaude, send = sendEmail }) {
  function summarizeCommits({ repo, pusher, commits, totalCommits = commits.length, context }) {
    return summarize({
      repo,
      pusher,
      commits: commits.slice(0, MAX_COMMITS_IN_PROMPT),
      totalCommits,
      context,
      apiKey: config.claude.apiKey,
      model: config.claude.model,
    });
  }

  // `client` is a mapping: { clientName, clientEmail }.
  function emailDigest({ installationId, client, repo, pusher, summary }) {
    const unsubscribeUrl = links.unsubscribeUrl({ installationId, repo, email: client.clientEmail });
    return send({
      to: client.clientEmail,
      subject: summary.headline,
      html: renderEmailHtml({ clientName: client.clientName, repo, pusher, summary, unsubscribeUrl }),
      headers: unsubscribeHeaders(unsubscribeUrl),
      apiKey: config.email.resendApiKey,
      fromEmail: config.email.from,
    });
  }

  return {
    fallbackSummary,

    // Returns { summary, kind, model, usage }. useClaude=false (over the
    // cap, or Claude disabled) skips the API call entirely.
    async buildDigest({ repo, pusher, commits, totalCommits, useClaude, context }) {
      if (!useClaude) {
        return { summary: fallbackSummary({ repo, commits, totalCommits }), kind: 'fallback', model: null, usage: null };
      }
      const { summary, model, usage } = await summarizeCommits({ repo, pusher, commits, totalCommits, context });
      return { summary, kind: 'ai', model, usage };
    },

    emailDigest,

    async sendConfirmation({ installationId, accountLogin, client, repo }) {
      const confirmUrl = links.confirmUrl({ installationId, repo, email: client.clientEmail });
      await send({
        to: client.clientEmail,
        subject: `Confirm project updates for ${repo}`,
        html: renderConfirmationHtml({ clientName: client.clientName, repo, accountLogin, confirmUrl }),
        apiKey: config.email.resendApiKey,
        fromEmail: config.email.from,
      });
    },

    // Dry run for the MCP preview tool: what the client would receive.
    async previewDigest({ repo, commits, pusher = 'preview' }) {
      const { summary } = await summarizeCommits({ repo, pusher, commits });
      return summary;
    },

    async sendTestDigest({ installationId, client, repo }) {
      const summary = {
        headline: `Test digest for ${repo}`,
        summary: 'This is a sample update email generated on demand.',
        highlights: ['This is a sample highlight.'],
        risk_notes: null,
      };
      await emailDigest({ installationId, client, repo, pusher: 'test', summary });
    },

    async resendDigest({ installationId, client, digest }) {
      await emailDigest({ installationId, client, repo: digest.repo, pusher: 'resend', summary: digest.summary });
    },
  };
}

module.exports = { createPipeline, fallbackSummary };