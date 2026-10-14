const { withRetry } = require('./retry');

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// GitHub push payload fields (repo, pusher name) and Claude-generated
// summary text both ultimately derive from attacker-influenceable input
// (anyone who can push a commit controls the pusher/author name and commit
// messages). None of that is safe to drop into HTML unescaped.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}


function layout(body, footer = '') {
  return `<!doctype html>
<html>
  <body style="font-family:sans-serif; line-height:1.5; max-width:640px;">
    ${body}
    ${footer}
  </body>
</html>`;
}

function unsubscribeFooter(unsubscribeUrl) {
  return `<hr style="border:none; border-top:1px solid #ddd; margin-top:32px;">
    <p style="color:#777; font-size:12px;">You receive these updates because a developer added you as the client for this project.
    <a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a></p>`;
}

function renderEmailHtml({ clientName, repo, pusher, summary, unsubscribeUrl }) {
  const highlightItems = summary.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join('');
  const riskNotes = summary.risk_notes
    ? `<p style="color:#a33;"><strong>Note:</strong> ${escapeHtml(summary.risk_notes)}</p>`
    : '';
  return layout(`
    <h1>${escapeHtml(summary.headline)}</h1>
    <p>${escapeHtml(repo)} &middot; pushed by ${escapeHtml(pusher)}</p>
    <p>${escapeHtml(summary.summary)}</p>
    <ul>${highlightItems}</ul>
    ${riskNotes}
    <p>Hi ${escapeHtml(clientName)}, this update was generated automatically from a recent code push.</p>`,
    unsubscribeUrl ? unsubscribeFooter(unsubscribeUrl) : ''
  );
}

function renderConfirmationHtml({ clientName, repo, accountLogin, confirmUrl }) {
  return layout(`
    <h1>Confirm project updates for ${escapeHtml(repo)}</h1>
    <p>Hi ${escapeHtml(clientName)},</p>
    <p>${escapeHtml(accountLogin)} wants to send you short, plain-English email updates whenever new work
    ships on <strong>${escapeHtml(repo)}</strong>.</p>
    <p><a href="${escapeHtml(confirmUrl)}" style="display:inline-block; padding:10px 16px; background:#1a5fb4; color:#fff; text-decoration:none; border-radius:6px;">Yes, send me updates</a></p>
    <p style="color:#777;">If you weren't expecting this, ignore this email and you won't hear from us again.
    The link expires in 7 days.</p>`);
}

// RFC 8058 one-click unsubscribe: mail providers show an "Unsubscribe"
// button and POST to the URL themselves.
function unsubscribeHeaders(unsubscribeUrl) {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

async function sendEmail({ to, subject, html, headers, apiKey, fromEmail, fetchImpl = fetch }) {
  const res = await withRetry(() => fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ from: fromEmail, to, subject, html, ...(headers ? { headers } : {}) }),
  }));
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend request failed: ${res.status} ${body}`);
  }
  return res.json();
}

module.exports = {
  renderEmailHtml,
  renderConfirmationHtml,
  unsubscribeHeaders,
  sendEmail,
  escapeHtml,
};
