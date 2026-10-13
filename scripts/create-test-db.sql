-- Runs once when the docker compose database is first created, so
-- `npm test` has its own database next to the dev one.
CREATE DATABASE relay_test OWNER relay;