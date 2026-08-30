const { summarizeWithClaude } = require('../lib/claude');

function fakeFetch(status, body) {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  });
}

const args = { repo: 'acme/site', pusher: 'octocat', commits: [{ message: 'Fix bug', author: { name: 'octocat' } }], apiKey: 'k' };

describe('summarizeWithClaude', () => {
  test('parses a clean JSON response', async () => {
    const payload = { headline: 'Bug fix shipped', summary: 'Fixed a pagination bug.'.padEnd(25, '.'), highlights: ['Fixed pagination'], risk_notes: null };
    const fetchImpl = fakeFetch(200, { content: [{ text: JSON.stringify(payload) }] });
    const result = await summarizeWithClaude({ ...args, fetchImpl });
    expect(result).toEqual(payload);
  });

  test('strips a markdown code fence around the JSON', async () => {
    const payload = { headline: 'Bug fix shipped', summary: 'Fixed a pagination bug.'.padEnd(25, '.'), highlights: ['Fixed pagination'] };
    const fenced = '```json\n' + JSON.stringify(payload) + '\n```';
    const fetchImpl = fakeFetch(200, { content: [{ text: fenced }] });
    const result = await summarizeWithClaude({ ...args, fetchImpl });
    expect(result.headline).toBe(payload.headline);
  });

  test('throws when the response fails the schema (extra field)', async () => {
    const payload = { headline: 'x'.padEnd(10, 'x'), summary: 'y'.padEnd(25, 'y'), highlights: ['z'], confidence: 0.9 };
    const fetchImpl = fakeFetch(200, { content: [{ text: JSON.stringify(payload) }] });
    await expect(summarizeWithClaude({ ...args, fetchImpl })).rejects.toThrow(/schema validation/);
  });

  test('throws on a non-OK response', async () => {
    const fetchImpl = fakeFetch(500, 'internal error');
    await expect(summarizeWithClaude({ ...args, fetchImpl })).rejects.toThrow(/Claude request failed/);
  });
});