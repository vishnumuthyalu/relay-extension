const crypto = require('crypto');

// Signed, stateless links for client emails: confirm a subscription and
// unsubscribe. The token carries (purpose, installation, repo, email) and
// an HMAC over them, so nothing has to be stored and a token can't be
// edited to point at another tenant or address. Confirm links expire;
// unsubscribe links don't (every old email must keep working).

const CONFIRM_TTL_SECONDS = 7 * 24 * 60 * 60;

function createLinks({ secret, publicUrl, now = () => Date.now() }) {
  // A separate key per use, so a session signature can never be replayed as a link.
  const key = crypto.createHmac('sha256', secret).update('relay:email-links:v1').digest();

  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', key).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  function verify(token, purpose) {
    if (typeof token !== 'string') return null;
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const expected = crypto.createHmac('sha256', key).update(body).digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    let payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (payload.p !== purpose) return null;
    if (payload.exp && payload.exp * 1000 < now()) return null;
    return { installationId: payload.i, repo: payload.r, email: payload.e };
  }

  function confirmUrl({ installationId, repo, email }) {
    const exp = Math.floor(now() / 1000) + CONFIRM_TTL_SECONDS;
    return `${publicUrl}/confirm?token=${sign({ p: 'confirm', i: installationId, r: repo, e: email, exp })}`;
  }

  function unsubscribeUrl({ installationId, repo, email }) {
    return `${publicUrl}/unsubscribe?token=${sign({ p: 'unsubscribe', i: installationId, r: repo, e: email })}`;
  }

  return {
    confirmUrl,
    unsubscribeUrl,
    verifyConfirm: (token) => verify(token, 'confirm'),
    verifyUnsubscribe: (token) => verify(token, 'unsubscribe'),
  };
}

module.exports = { createLinks, CONFIRM_TTL_SECONDS };