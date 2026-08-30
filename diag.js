process.env.GITHUB_WEBHOOK_SECRET = 't';
process.env.ANTHROPIC_API_KEY = 't';
process.env.RESEND_API_KEY = 't';
process.env.FROM_EMAIL = 't@t.com';
process.env.CONFIG_API_KEY = 't';

console.log('1: env set');
try {
  require('dotenv/config');
  console.log('2: dotenv ok');
  require('express');
  console.log('3: express ok');
  const OpenApiValidator = require('express-openapi-validator');
  console.log('4: express-openapi-validator required');
  const { openDb } = require('./lib/db');
  console.log('5: db lib required');
  const db = openDb();
  console.log('6: db opened');
  const mw = OpenApiValidator.middleware({
    apiSpec: require('path').join(__dirname, 'spec', 'openapi.yaml'),
    validateRequests: true,
    validateResponses: true,
  });
  console.log('7: openapi middleware built', typeof mw);
} catch (err) {
  console.error('CRASHED:', err);
}
console.log('done');