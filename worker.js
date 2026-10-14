// Worker process: takes process-push jobs off the queue and sends digests.
// Runs separately from the web process (npm run worker), so slow Claude or
// Resend calls never hold up webhook responses, and each side scales alone.
require('dotenv/config');
const pino = require('pino');
const { loadConfig } = require('./lib/config');
const { createPool } = require('./lib/db/pool');
const { migrate } = require('./lib/db/migrate');
const { createLinks } = require('./lib/links');
const { createPipeline } = require('./lib/pipeline');
const { createProcessPush } = require('./lib/jobs/process-push');
const { startQueue, PROCESS_PUSH } = require('./lib/queue');

async function main() {
  const log = pino();
  const config = loadConfig();
  const pool = createPool({ connectionString: config.databaseUrl });
  await migrate(pool, { log: (m) => log.info(m) });

  const links = createLinks({ secret: config.sessionSecret, publicUrl: config.publicUrl });
  const pipeline = createPipeline({ config, links });
  const processPush = createProcessPush({ pool, pipeline, config });
  const queue = await startQueue({ connectionString: config.databaseUrl, log });

  await queue.boss.work(PROCESS_PUSH, { includeMetadata: true }, async (jobs) => {
    for (const job of jobs) {
      const isFinalAttempt = job.retryCount >= job.retryLimit;
      try {
        const result = await processPush(job.data, { isFinalAttempt });
        log.info({ deliveryId: job.data.deliveryId, ...result }, 'delivery processed');
      } catch (err) {
        log.error({ err, deliveryId: job.data.deliveryId, attempt: job.retryCount + 1 }, 'delivery failed');
        throw err; // pg-boss schedules the retry
      }
    }
  });
  log.info('worker ready');

  const shutdown = async (signal) => {
    log.info({ signal }, 'shutting down');
    await queue.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});