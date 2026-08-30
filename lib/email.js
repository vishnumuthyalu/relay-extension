function renderEmailHtml({ clientName, repo, pusher, summary }) {
  const highlights = summary.highlights.map((h) => `${h}`).join('');
  return `
    
      ${summary.headline}
      ${repo} · pushed by ${pusher}
      ${summary.summary}
      ${highlights}
      ${summary.risk_notes ? `Note: ${summary.risk_notes}` : ''}
      Hi ${clientName}, this update was generated automatically from a recent code push.
    `;
}

async function sendEmail({ to, subject, html, apiKey, fromEmail, fetchImpl = fetch }) {
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ from: fromEmail, to, subject, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend request failed: ${res.status} ${body}`);
  }
  return res.json();
}

module.exports = { renderEmailHtml, sendEmail };