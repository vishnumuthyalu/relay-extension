module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup-env.js'],
  collectCoverageFrom: ['lib/**/*.js', 'server.js'],
  // The first request compiles the OpenAPI spec, which can take several
  // seconds on Windows or a busy CI runner; 5 s (Jest's default) is too tight.
  testTimeout: 20000,
};
