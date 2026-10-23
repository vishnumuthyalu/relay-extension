module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/setup-env.js'],
  testPathIgnorePatterns: ['/node_modules/', '/extension/'],
  collectCoverageFrom: ['lib/**/*.js', 'routes/**/*.js', 'mcp/**/*.js', 'server.js'],
  // The first request compiles the OpenAPI spec, which can take several
  // seconds on Windows or a busy CI runner; 5 s (Jest's default) is too tight.
  testTimeout: 20000,
  // Just under today's numbers (about 86% statements, 74% branches): CI
  // fails if a change lowers coverage, so it can only go up. Raise these as
  // coverage improves.
  coverageThreshold: {
    global: { statements: 85, branches: 72, functions: 85, lines: 88 },
  },
};
