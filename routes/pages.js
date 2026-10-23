const express = require('express');
const { page } = require('../lib/html');

// Public pages the GitHub App listing links to. Keep the privacy page in
// step with docs/github-app.md ("What Relay stores, and deleting it").

const PRIVACY = `
  <p class="muted">Last updated when this version of Relay was deployed.</p>
  <h2>What Relay stores</h2>
  <ul>
    <li>For each GitHub account or organization that installs Relay: its GitHub installation id, login and type, and which GitHub users may manage it.</li>
    <li>For each repository you connect: the client's name and email address, and whether they confirmed or unsubscribed.</li>
    <li>For each digest: the repository, recipient, the summary text, when it was sent, and how many Claude tokens it used.</li>
    <li>If you connect a ticket tracker: its MCP server address, the tools Relay may call, and your access token, encrypted.</li>
    <li>If you connect an MCP client: which client it is and hashed refresh tokens, so it can stay signed in.</li>
  </ul>
  <h2>What Relay does not store</h2>
  <ul>
    <li>Your source code, or GitHub access tokens. Short-lived installation tokens are kept in memory only.</li>
  </ul>
  <h2>Who processes it</h2>
  <ul>
    <li>Anthropic (Claude) receives commit messages, and, if you turn them on, pull request descriptions and ticket notes, to write each summary.</li>
    <li>Resend delivers the emails.</li>
    <li>The hosting provider runs the servers and the database.</li>
  </ul>
  <h2>Deleting your data</h2>
  <p>Uninstall the Relay GitHub App from your account or organization settings on GitHub. Relay deletes everything listed above for that installation as soon as GitHub tells it. Clients can unsubscribe from any digest with one click.</p>
`;

function createPublicPagesRouter() {
  const router = express.Router();
  router.get('/privacy', (req, res) => res.send(page('Privacy and your data', PRIVACY)));
  return router;
}

module.exports = { createPublicPagesRouter };