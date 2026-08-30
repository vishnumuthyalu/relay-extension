const { withRetry } = require('./retry');

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// GitHub push payload fields (repo, pusher name) and Claude-generated
// summary text both ultimately derive from attacker-influenceable input
// (anyone who can push a commit controls the pusher/author name and commit
// messages). None of that is safe to drop into HTML unescaped.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

function renderEmailHtml({ clientName, repo, pusher, summary }) {
  const highlightItems = summary.highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join('');
  const riskNotes = summary.risk_notes
    ? `<p style="color:#a33;"><strong>Note:</strong> ${escapeHtml(summary.risk_notes)}</p>`
    : '';

  return `<!doctype html>
<html>
  <body style="font-family:sans-serif; line-height:1.5;">
    <h1>${escapeHtml(summary.headline)}</h1>
    <p>${escapeHtml(repo)} &middot; pushed by ${escapeHtml(pusher)}</p>
    <p>${escapeHtml(summary.summary)}</p>
    <ul>${highlightItems}</ul>
    ${riskNotes}
    <p>Hi ${escapeHtml(clientName)}, this update was generated automatically from a recent code push.</p>
  </body>
</html>`;
}

async function sendEmail({ to, subject, html, apiKey, fromEmail, fetchImpl = fetch }) {
  const res = await withRetry(() => fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ from: fromEmail, to, subject, html }),
  }));
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend request failed: ${res.status} ${body}`);
  }
  return res.json();
}

module.exports = { renderEmailHtml, sendEmail, escapeHtml };
