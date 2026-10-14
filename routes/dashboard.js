const express = require('express');
const db = require('../lib/db');
const { createRelayService, RelayError } = require('../lib/service');
const { page, hidden, escapeHtml } = require('../lib/html');
const { csrfToken, validCsrf } = require('../lib/csrf');

// A small server-rendered dashboard for people who don't use an MCP
// client: install the app, map repositories to clients, send a test,
// see history and usage. It calls the same RelayService as the API and
// the MCP tools, so the rules are identical everywhere.

const REPO = /^[\w.-]+\/[\w.-]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function createDashboardRouter({ pool, pipeline, config }) {
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '8kb' });

  router.get('/', (req, res) => res.redirect('/dashboard'));

  // Signed-in pages only; the rest bounce through Sign in with GitHub.
  router.use('/dashboard', (req, res, next) => {
    if (!req.session?.uid) return res.redirect(`/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
    req.user = { githubUserId: req.session.uid, login: req.session.login };
    next();
  });

  // Every POST must carry the session's CSRF token.
  router.post('/dashboard/*path', form, (req, res, next) => {
    if (!validCsrf(req)) return res.status(403).send(page('Please try again', '<p>That form expired. Go back and reload the page.</p>'));
    next();
  });

  const nav = (req) => `<nav><a href="/dashboard">Relay</a>
    <form method="post" action="/dashboard/logout" class="inline">${hidden({ _csrf: csrfToken(req) })}
    <span class="muted">${escapeHtml(req.user.login)}</span> <button type="submit">Sign out</button></form></nav>`;

  // One-time message shown after a form redirect.
  function takeFlash(req) {
    const flash = req.session.flash;
    delete req.session.flash;
    return flash ? `<p class="${flash.error ? 'warn' : 'muted'}">${escapeHtml(flash.text)}</p>` : '';
  }

  router.get('/dashboard', async (req, res) => {
    const installations = await db.listUserInstallations(pool, req.user.githubUserId);
    const rows = installations.map((i) => `<tr>
        <td><a href="/dashboard/${i.id}">${escapeHtml(i.account_login)}</a></td>
        <td class="muted">${escapeHtml(i.account_type)}</td>
        <td>${i.suspended_at ? '<span class="pill warn">suspended</span>' : ''}</td></tr>`).join('');
    res.send(page('Your accounts', `
      ${takeFlash(req)}
      ${installations.length
        ? `<table><tr><th>Account</th><th>Type</th><th></th></tr>${rows}</table>`
        : '<p>Relay isn\'t installed on any account you can manage yet.</p>'}
      <p><a href="/install">Install Relay on an account or organization</a>.
      <span class="muted">After installing, <a href="/auth/login?returnTo=/dashboard">sign in again</a> to see it here.</span></p>`,
    { nav: nav(req) }));
  });

  // Loads the installation and checks membership; others get a 404 page.
  router.use('/dashboard/:installationId', async (req, res, next) => {
    const id = Number(req.params.installationId);
    if (!Number.isSafeInteger(id) || !(await db.isMember(pool, id, req.user.githubUserId))) {
      return res.status(404).send(page('Not found', '<p>That account doesn\'t exist or you can\'t manage it.</p>'));
    }
    req.installation = await db.getInstallation(pool, id);
    req.relay = createRelayService({ pool, pipeline, config, installation: req.installation });
    next();
  });

  router.get('/dashboard/:installationId', async (req, res) => {
    const { relay, installation } = req;
    const [mappings, digests, usage, settings] = await Promise.all([
      relay.listMappings(), relay.listDigests({ limit: 10 }), relay.getUsage(), relay.getSummarySettings(),
    ]);
    const base = `/dashboard/${installation.id}`;
    const csrf = csrfToken(req);
    const action = (path, repo, label) =>
      `<form method="post" action="${base}${path}" class="inline">${hidden({ _csrf: csrf, repo })}<button type="submit">${label}</button></form>`;

    const mappingRows = mappings.map((m) => `<tr>
        <td>${escapeHtml(m.repo)}${m.branch ? `<div class="muted">branch ${escapeHtml(m.branch)}</div>` : ''}</td>
        <td>${escapeHtml(m.clientName)}<div class="muted">${escapeHtml(m.clientEmail)}</div></td>
        <td><span class="pill">${m.status === 'pending' ? 'waiting for confirmation' : escapeHtml(m.status)}</span></td>
        <td>${m.status === 'active' ? action('/mappings/test', m.repo, 'Send test') : ''} ${action('/mappings/remove', m.repo, 'Remove')}</td>
      </tr>`).join('');

    const digestRows = digests.map((d) => `<tr>
        <td class="muted">${escapeHtml(d.sentAt.slice(0, 16).replace('T', ' '))}</td>
        <td>${escapeHtml(d.repo)}</td>
        <td>${escapeHtml(d.headline)}${d.kind === 'fallback' ? ' <span class="pill">plain</span>' : ''}</td>
        <td class="muted">${escapeHtml(d.recipient)}</td></tr>`).join('');

    res.send(page(installation.account_login, `
      ${takeFlash(req)}
      ${installation.suspended_at ? '<p class="warn">This installation is suspended on GitHub; no digests are sent.</p>' : ''}
      <h2>Clients</h2>
      ${mappings.length ? `<table><tr><th>Repository</th><th>Client</th><th>Status</th><th></th></tr>${mappingRows}</table>`
        : '<p class="muted">No repositories are mapped yet.</p>'}
      <form method="post" action="${base}/mappings">${hidden({ _csrf: csrf })}
        <div class="row">
          <label>Repository<input name="repo" placeholder="${escapeHtml(installation.account_login)}/website" required></label>
          <label>Client name<input name="clientName" required maxlength="120"></label>
          <label>Client email<input name="clientEmail" type="email" required></label>
          <label>Branch (optional)<input name="branch" placeholder="default branch"></label>
          <button type="submit">Save</button>
        </div>
        <p class="muted">New clients get an email asking them to confirm. Digests start once they do.</p>
      </form>
      <h2>Summaries</h2>
      ${summarySettings(base, csrf, settings)}
      <h2>This month</h2>
      <p>${usage.digestsSent} of ${usage.monthlyCap} Claude-written digests used${usage.fallbackSent ? `, plus ${usage.fallbackSent} plain digests over the cap` : ''}.
      ${usage.claudeEnabled ? '' : '<span class="warn">Claude summaries are turned off on this server.</span>'}</p>
      <h2>Recent digests</h2>
      ${digests.length ? `<table><tr><th>Sent (UTC)</th><th>Repository</th><th>Headline</th><th>To</th></tr>${digestRows}</table>`
        : '<p class="muted">Nothing sent yet.</p>'}`,
    { nav: nav(req) }));
  });
  function summarySettings(base, csrf, settings) {
    const github = settings.githubContextAvailable
      ? `<form method="post" action="${base}/settings/enrichment">${hidden({ _csrf: csrf, enabled: settings.enrichmentEnabled ? 'off' : 'on' })}
          <p>Use merged pull request titles and descriptions: <strong>${settings.enrichmentEnabled ? 'on' : 'off'}</strong>
          <button type="submit">Turn ${settings.enrichmentEnabled ? 'off' : 'on'}</button></p></form>`
      : '<p class="muted">Pull request context isn\'t configured on this server.</p>';

    let tracker;
    if (!settings.integrationsAvailable) {
      tracker = '<p class="muted">Ticket trackers aren\'t enabled on this server.</p>';
    } else if (settings.integration) {
      const i = settings.integration;
      tracker = `<p>Ticket tracker: <strong>${escapeHtml(i.name)}</strong> <span class="muted">(${escapeHtml(i.mcpUrl)}; tools: ${escapeHtml(i.allowedTools.join(', '))})</span></p>
        <form method="post" action="${base}/integration/remove">${hidden({ _csrf: csrf })}<button type="submit">Disconnect</button></form>`;
    } else {
      tracker = `<form method="post" action="${base}/integration">${hidden({ _csrf: csrf })}
        <p>Connect a ticket tracker's MCP server, so digests can name the issues a push closes.</p>
        <div class="row">
          <label>Name<input name="name" placeholder="Linear" required maxlength="40"></label>
          <label>MCP server URL<input name="mcpUrl" type="url" placeholder="https://…" required></label>
          <label>Access token<input name="token" type="password" required autocomplete="off"></label>
          <label>Read-only tools<input name="allowedTools" placeholder="get_issue" required></label>
          <button type="submit">Connect</button>
        </div>
        <p class="muted">Claude may call only the tools you list here, so list read-only ones. The token is stored encrypted and never shown again.</p>
      </form>`;
    }
    return github + tracker;
  }


  // Runs a dashboard action, stores its outcome as a flash message and
  // redirects back (post/redirect/get).
  const act = (fn) => async (req, res, next) => {
    try {
      req.session.flash = { text: await fn(req) };
    } catch (err) {
      if (!(err instanceof RelayError)) return next(err);
      req.session.flash = { text: err.message, error: true };
    }
    res.redirect(`/dashboard/${req.installation.id}`);
  };

  router.post('/dashboard/:installationId/mappings', act(async (req) => {
    const repo = String(req.body.repo || '').trim();
    const clientName = String(req.body.clientName || '').trim();
    const clientEmail = String(req.body.clientEmail || '').trim();
    const branch = String(req.body.branch || '').trim() || null;
    if (!REPO.test(repo)) throw new RelayError('Use the owner/repo form for the repository, e.g. acme/website.');
    if (!clientName || clientName.length > 120) throw new RelayError('Enter a client name (up to 120 characters).');
    if (!EMAIL.test(clientEmail)) throw new RelayError('Enter a valid client email.');
    const mapping = await req.relay.setMapping({ repo, clientName, clientEmail, branch });
    return mapping.confirmationSent
      ? `Saved. A confirmation email went to ${mapping.clientEmail}.`
      : `Saved ${mapping.repo}.`;
  }));

  router.post('/dashboard/:installationId/mappings/remove', act(async (req) => {
    const { removed } = await req.relay.removeMapping({ repo: String(req.body.repo) });
    return removed ? `Removed ${req.body.repo}.` : `${req.body.repo} wasn't mapped.`;
  }));

  router.post('/dashboard/:installationId/mappings/test', act(async (req) => {
    const { sentTo } = await req.relay.sendTestDigest({ repo: String(req.body.repo) });
    return `Test digest sent to ${sentTo}.`;
  }));

    router.post('/dashboard/:installationId/settings/enrichment', act(async (req) => {
    const enabled = req.body.enabled === 'on';
    await req.relay.setEnrichment(enabled);
    return `Pull request context turned ${enabled ? 'on' : 'off'}.`;
  }));

  router.post('/dashboard/:installationId/integration', act(async (req) => {
    const allowedTools = String(req.body.allowedTools || '').split(',').map((t) => t.trim()).filter(Boolean);
    await req.relay.saveIntegration({
      name: String(req.body.name || '').trim(),
      mcpUrl: String(req.body.mcpUrl || '').trim(),
      token: String(req.body.token || '').trim(),
      allowedTools,
    });
    return 'Ticket tracker connected.';
  }));

  router.post('/dashboard/:installationId/integration/remove', act(async (req) => {
    await req.relay.removeIntegration();
    return 'Ticket tracker disconnected.';
  }));


  return router;
}

// Registered before the /dashboard/:installationId routes, so "logout"
// is never read as an installation id.
function createLogoutRoute() {
  const router = express.Router();
  router.post('/dashboard/logout', express.urlencoded({ extended: false, limit: '1kb' }), (req, res) => {
    if (!validCsrf(req)) return res.status(403).send(page('Please try again', '<p>That form expired.</p>'));
    req.session = null;
    // Not '/': that bounces through /dashboard to GitHub sign-in, and GitHub
    // signs a returning user straight back in without asking.
    res.redirect('/signed-out');
  });
  router.get('/signed-out', (req, res) => {
    res.send(page('Signed out', '<p>You are signed out of Relay.</p><p><a href="/auth/login">Sign in again</a></p>'));
  });
  return router;
}

module.exports = { createDashboardRouter, createLogoutRoute };
