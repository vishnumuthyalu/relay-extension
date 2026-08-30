const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const summarySchema = require('../spec/summary.schema.json');

const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
const validateSummary = ajv.compile(summarySchema);

// Check Anthropic's docs for the current model id — this is deliberately
// not hardcoded to one snapshot so the guide doesn't go stale.
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

function stripFences(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1].trim() : text.trim();
}

async function summarizeWithClaude({ repo, pusher, commits, apiKey, model, fetchImpl = fetch }) {
  const commitList = commits
    .map((c) => `- ${c.message.split('\n')[0]} (${c.author?.name || pusher})`)
    .join('\n');

  const prompt = `You summarize code pushes for a non-technical client update email.
Repo: ${repo}
Pushed by: ${pusher}
Commits:
${commitList}

Respond with ONLY a JSON object matching this exact shape, no markdown fences, no extra keys:
{"headline": string, "summary": string, "highlights": string[], "risk_notes": string|null}`;

  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Claude request failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const raw = data?.content?.[0]?.text || '';
  const parsed = JSON.parse(stripFences(raw));

  if (!validateSummary(parsed)) {
    throw new Error(
      `Claude output failed schema validation: ${ajv.errorsText(validateSummary.errors)}`
    );
  }
  return parsed;
}

module.exports = { summarizeWithClaude, validateSummary, DEFAULT_MODEL };