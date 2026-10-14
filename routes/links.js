const express = require('express');
const db = require('../lib/db');
const { escapeHtml } = require('../lib/email');

// Pages clients reach from emails. GET only ever shows a button: mail
// scanners prefetch links, and a GET that changed state would confirm or
// unsubscribe people without them clicking anything.

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Relay</title>
</head>
<body style="font-family:sans-serif; max-width:520px; margin:64px auto; padding:0 16px; line-height:1.5;">
  <h1 style="font-size:22px;">${escapeHtml(title)}</h1>
  ${body}
</body>
</html>`;
}

function button(action, token, label) {
  return `<form method="post" action="${action}">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <button type="submit" style="padding:10px 16px; font-size:16px;">${escapeHtml(label)}</button>
  </form>`;
}

const invalid = page('This link is no longer valid', '<p>It may have expired, or the address was changed. Ask the developer to send a new one.</p>');

function createLinksRouter({ pool, links }) {
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '4kb' });
  const tokenOf = (req) => req.body?.token || req.query.token;

  router.get('/confirm', (req, res) => {
    const target = links.verifyConfirm(req.query.token);
    if (!target) return res.status(400).send(invalid);
    res.send(page('Confirm project updates', `<p>Send plain-English updates about <strong>${escapeHtml(target.repo)}</strong>
      to <strong>${escapeHtml(target.email)}</strong>?</p>${button('/confirm', req.query.token, 'Yes, send me updates')}`));
  });

  router.post('/confirm', form, async (req, res, next) => {
    try {
      const target = links.verifyConfirm(tokenOf(req));
      if (!target || !(await db.confirmMapping(pool, target.installationId, target.repo, target.email))) {
        return res.status(400).send(invalid);
      }
      res.send(page("You're subscribed", `<p>You'll get an email when new work ships on ${escapeHtml(target.repo)}.
        Every email has an unsubscribe link.</p>`));
    } catch (err) {
      next(err);
    }
  });

  router.get('/unsubscribe', (req, res) => {
    const target = links.verifyUnsubscribe(req.query.token);
    if (!target) return res.status(400).send(invalid);
    res.send(page('Unsubscribe', `<p>Stop updates about <strong>${escapeHtml(target.repo)}</strong>
      to <strong>${escapeHtml(target.email)}</strong>?</p>${button('/unsubscribe', req.query.token, 'Unsubscribe')}`));
  });

  // Handles both the button above and RFC 8058 one-click POSTs from mail
  // providers (token in the query string, body "List-Unsubscribe=One-Click").
  router.post('/unsubscribe', form, async (req, res, next) => {
    try {
      const target = links.verifyUnsubscribe(tokenOf(req));
      if (!target) return res.status(400).send(invalid);
      await db.unsubscribeMapping(pool, target.installationId, target.repo, target.email);
      res.send(page("You're unsubscribed", `<p>You won't get more updates about ${escapeHtml(target.repo)}.</p>`));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createLinksRouter };