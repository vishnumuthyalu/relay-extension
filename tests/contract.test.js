const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const request = require('supertest');
const { createApp } = require('../server');
const { testConfig } = require('./helpers/fixtures');
const pushEventSchema = require('../spec/push-event.schema.json');
const spec = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'spec', 'openapi.yaml'), 'utf8'));
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);

describe('spec/push-event.schema.json as a test oracle', () => {
  test('a real GitHub App push payload satisfies it', () => {
    const validate = ajv.compile(pushEventSchema);
    const fixture = {
      ref: 'refs/heads/main',
      installation: { id: 123 },
      repository: { full_name: 'acme/site', default_branch: 'main', owner: { login: 'acme', type: 'Organization' } },
      pusher: { name: 'octocat' },
      commits: [{ id: 'a1b2c3d', message: 'Fix bug', url: 'https://github.com/acme/site/commit/a1b2c3d' }],
    };
    expect(validate(fixture)).toBe(true);
  });
  });
  describe('spec/openapi.yaml as a test oracle', () => {

  test('GET /health matches its documented 200 schema', async () => {
    // /health touches nothing, so no database or queue is needed.
    const app = createApp({ config: testConfig(), pool: {}, queue: {}, pipeline: {}, links: {}, github: {} });
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