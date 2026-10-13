// Runs before every test file (see jest.config.js).
process.env.NODE_ENV = 'test';
// Postgres for tests. docker-compose.yml starts one on this URL; CI uses a
// service container. Each test file gets its own schema (tests/helpers/db.js).
process.env.TEST_DATABASE_URL ||= 'postgres://relay:relay@localhost:5432/relay_test';