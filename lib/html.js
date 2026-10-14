const { escapeHtml } = require('./email');

// Small server-rendered pages: the email link pages, the OAuth consent
// screen and the dashboard. No template engine; every interpolated value
// goes through escapeHtml.

const STYLE = `
  :root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --bg: #fff; --accent: #1a5fb4; --warn: #a33; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6; --line: #3a3a3c; --bg: #1c1c1e; --accent: #78aeed; --warn: #f28b82; } }
  body { font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); max-width: 760px; margin: 48px auto; padding: 0 16px; }
  h1 { font-size: 22px; margin: 0 0 16px; } h2 { font-size: 18px; margin: 32px 0 8px; }
  a { color: var(--accent); } .muted { color: var(--muted); } .warn { color: var(--warn); }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; font-size: 15px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  form.inline { display: inline; } input, select { font: inherit; padding: 6px 8px; margin: 4px 0; }
  button { font: inherit; padding: 6px 14px; cursor: pointer; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: end; } .row label { display: flex; flex-direction: column; font-size: 14px; }
  .pill { font-size: 13px; padding: 1px 8px; border: 1px solid var(--line); border-radius: 999px; }
  nav { display: flex; justify-content: space-between; margin-bottom: 24px; font-size: 14px; }
`;

function page(title, body, { nav = '' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Relay</title>
  <style>${STYLE}</style>
</head>
<body>
  ${nav}
  <h1>${escapeHtml(title)}</h1>
  ${body}
</body>
</html>`;
}

function hidden(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('');
}

module.exports = { page, hidden, escapeHtml };
