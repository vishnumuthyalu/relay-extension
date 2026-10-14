# ADR 003: Postgres and pg-boss instead of SQLite and in-process work

## Status
Accepted

## Context
A single SQLite file works for one server on one machine. A hosted,
multi-tenant Relay needs a database several processes can share, and
digest work (Claude, then Resend) that survives restarts and retries
failures without holding the webhook request open.

## Decision
- Store everything in Postgres, with plain SQL migrations in `migrations/`
  applied by `lib/db/migrate.js` under an advisory lock.
- Queue work with pg-boss, which keeps jobs in the same Postgres database.
  The webhook claims the delivery, enqueues a `process-push` job and replies
  202. A separate worker process sends the digest, with retries and
  exponential backoff.

## Alternatives considered
- **BullMQ + Redis**: mature, but adds a second datastore to run and pay for.
- **In-process background promises** (Phase 1): simple, but work is lost on
  restart and there's no retry.

## Consequences
- One managed Postgres is the only stateful dependency.
- Web and worker scale independently and can restart safely.
- Tests run against a real Postgres (one schema per test file), locally via
  docker compose and in CI as a service container.