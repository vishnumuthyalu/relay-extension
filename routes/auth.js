const crypto = require('crypto');
const express = require('express');
const db = require('../lib/db');

// "Sign in with GitHub" through the GitHub App's user authorization.
// The session (a signed cookie, see server.js) holds only the GitHub
// user id and login; which installations they can manage is re-read from
// GitHub on every sign-in and stored in installation_members.

function createAuthRouter({ pool, github, config }) {
  const router = express.Router();
  const redirectUri = `${config.publicUrl}/auth/callback`;

  router.get('/auth/login', (req, res) => {
    const state = crypto.randomBytes(16).toString('base64url');
    req.session.oauthState = state;
    // Only allow same-site paths, so the login can't be used as an open redirect.
    const returnTo = typeof req.query.returnTo === 'string' && /^\/(?!\/)/.test(req.query.returnTo)
      ? req.query.returnTo
      : '/api/me';
    req.session.returnTo = returnTo;
    res.redirect(github.authorizeUrl({ state, redirectUri }));
  });

  router.get('/auth/callback', async (req, res, next) => {
    try {
      const { code, state } = req.query;
      const expected = req.session.oauthState;
      delete req.session.oauthState;
      if (!code || !state || !expected || state !== expected) {
        return res.status(400).send('Sign-in expired or was tampered with. Please try again.');
      }

      const token = await github.exchangeCode({ code, redirectUri });
      const user = await github.getUser(token);
      const installations = await github.listInstallations(token);

      await db.upsertUser(pool, user);
      await db.syncMemberships(pool, user.githubUserId, installations);

      // The GitHub token is not kept: everything later is authorized
      // against installation_members.
      const returnTo = req.session.returnTo || '/api/me';
      req.session = { uid: user.githubUserId, login: user.login };
      res.redirect(returnTo);
    } catch (err) {
      next(err);
    }
  });

  // Stable link for "Add Relay to GitHub" buttons (dashboard, extension, README).
  router.get('/install', (req, res) => res.redirect(github.installUrl));

  router.post('/auth/logout', (req, res) => {
    req.session = null;
    res.status(204).end();
  });

  return router;
}

function requireUser(req, res, next) {
  if (!req.session?.uid) return res.status(401).json({ error: 'sign in at /auth/login' });
  req.user = { githubUserId: req.session.uid, login: req.session.login };
  next();
}

// Loads :installationId and checks the signed-in user may manage it.
// Answers 404 rather than 403, so ids of other tenants aren't confirmed.
function requireInstallationAccess(pool) {
  return async (req, res, next) => {
    try {
      const installationId = Number(req.params.installationId);
      const allowed = Number.isSafeInteger(installationId)
        && (await db.isMember(pool, installationId, req.user.githubUserId));
      if (!allowed) return res.status(404).json({ error: 'installation not found' });
      req.installation = await db.getInstallation(pool, installationId);
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { createAuthRouter, requireUser, requireInstallationAccess };