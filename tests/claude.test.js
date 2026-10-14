const { summarizeWithClaude, buildPrompt, SummaryError, DEFAULT_MODEL } = require('../lib/claude');

function fakeFetch(status, body) {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  });
}

const args = { repo: 'acme/site', pusher: 'octocat', commits: [{ message: 'Fix bug', author: { name: 'octocat' } }], apiKey: 'k' };
const good = { headline: 'Bug fix shipped', summary: 'Fixed a pagination bug.'.padEnd(25, '.'), highlights: ['Fixed pagination'], risk_notes: null };

describe('summarizeWithClaude', () => {
    test('parses a structured-output response and reports usage', async () => {
    const fetchImpl = fakeFetch(200, {
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 120, output_tokens: 80 },
      content: [{ type: 'text', text: JSON.stringify(good) }],
    });
    await expect(summarizeWithClaude({ ...args, fetchImpl })).resolves.toEqual({
      summary: good,
      model: 'claude-haiku-4-5',
      usage: { inputTokens: 120, outputTokens: 80 },
    });
  });

  test('requests structured output, a system prompt and the default model', async () => {
    const fetchImpl = fakeFetch(200, { content: [{ type: 'text', text: JSON.stringify(good) }] });
    await summarizeWithClaude({ ...args, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema.required).toContain('headline');
    expect(body.system).toMatch(/untrusted/);
    expect(body.model).toBe(process.env.ANTHROPIC_MODEL || DEFAULT_MODEL);
  });

  test('throws SummaryError on unparseable text', async () => {
    const fetchImpl = fakeFetch(200, { content: [{ type: 'text', text: 'not json' }] });
    await expect(summarizeWithClaude({ ...args, fetchImpl })).rejects.toBeInstanceOf(SummaryError);
  });

  test('throws SummaryError when the reply was cut off', async () => {
    const fetchImpl = fakeFetch(200, { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"headline":' }] });
    await expect(summarizeWithClaude({ ...args, fetchImpl })).rejects.toThrow(/max_tokens/);
  });

  test('throws when the response fails the length limits', async () => {
    const tooLong = { ...good, headline: 'x'.repeat(200) };
    const fetchImpl = fakeFetch(200, { content: [{ type: 'text', text: JSON.stringify(tooLong) }] });
    await expect(summarizeWithClaude({ ...args, fetchImpl })).rejects.toThrow(/schema validation/);
  });

  test('throws on a non-OK response', async () => {
    const fetchImpl = fakeFetch(400, 'bad request');
    await expect(summarizeWithClaude({ ...args, fetchImpl })).rejects.toThrow(/Claude request failed/);
  });
});

describe('buildPrompt', () => {
  test('caps the commit list and reports the remainder', () => {
    const commits = Array.from({ length: 60 }, (_, i) => ({ message: `Commit ${i}\nbody`, author: { name: 'a' } }));
    const prompt = buildPrompt({ repo: 'acme/site', pusher: 'octocat', commits });
    expect(prompt).toContain('Commit 49');
    expect(prompt).not.toContain('Commit 50');
    expect(prompt).toContain('and 10 more commits');
    expect(prompt).not.toContain('body');
  });
});
