// The job queue, backed by pg-boss in the same Postgres database, so
// Relay needs no Redis. pg-boss is an ES module, so it is loaded with a
// dynamic import() only when a real queue is started; tests pass a fake.

const PROCESS_PUSH = 'process-push';

const QUEUE_OPTIONS = {
  retryLimit: 3,        // 4 attempts in total
  retryDelay: 30,       // seconds, doubled each retry (retryBackoff)
  retryBackoff: true,
  retryDelayMax: 300,
};

async function startQueue({ connectionString, log = console }) {
  const { PgBoss } = await import('pg-boss');
  const boss = new PgBoss({ connectionString, schema: 'pgboss' });
  boss.on('error', (err) => log.error({ err }, 'pg-boss error'));
  await boss.start();
  await boss.createQueue(PROCESS_PUSH, QUEUE_OPTIONS);

  return {
    boss,
    enqueuePush: (data) => boss.send(PROCESS_PUSH, data),
    stop: () => boss.stop({ graceful: true }),
  };
}

module.exports = { startQueue, PROCESS_PUSH, QUEUE_OPTIONS };