const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Ajv2020 = require('ajv/dist/2020'); 
const addFormats = require('ajv-formats');
const request = require('supertest');

const spec = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'spec', 'openapi.yaml'), 'utf8'));
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);

describe('spec/openapi.yaml as a test oracle', () => {
  test('a real push payload satisfies the PushEvent schema', () => {
    const validate = ajv.compile(spec.components.schemas.PushEvent);
    const fixture = {
      ref: 'refs/heads/main',
      repository: { full_name: 'acme/site' },
      pusher: { name: 'octocat' },
      commits: [{ id: 'a1b2c3d', message: 'Fix bug', url: 'https://github.com/acme/site/commit/a1b2c3d' }],
    };
    expect(validate(fixture)).toBe(true);
  });

  test('GET /health matches its documented 200 schema', async () => {
    process.env.GITHUB_WEBHOOK_SECRET ||= 't'; process.env.ANTHROPIC_API_KEY ||= 't';
    process.env.RESEND_API_KEY ||= 't'; process.env.FROM_EMAIL ||= 't@t.com'; process.env.CONFIG_API_KEY ||= 't';
    const { app } = require('../server');
    const res = await request(app).get('/health');
    const schema = spec.paths['/health'].get.responses['200'].content['application/json'].schema;
    expect(ajv.compile(schema)(res.body)).toBe(true);
  });
});

describe('spec/summary.schema.json as a test oracle', () => {
  test('a well-formed summary passes; a missing field fails', () => {
    const schema = require('../spec/summary.schema.json');
    const validate = ajv.compile(schema);
    expect(validate({ headline: 'Ship it'.padEnd(6, '.'), summary: 'a'.repeat(30), highlights: ['Fixed pagination bug'] })).toBe(true);
    expect(validate({ headline: 'Ship it'.padEnd(6, '.'), highlights: ['Fixed pagination bug'] })).toBe(false);
  });
});