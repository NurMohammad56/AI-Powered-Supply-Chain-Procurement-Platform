import { connectDatabase, disconnectDatabase } from './config/database.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { logger } from './config/logger.js';
import { closeQueues, scheduledQueue } from './shared/queue/queues.js';
import { env } from './config/env.js';
import { startEmailWorker } from './workers/email.worker.js';
import { startReportWorker } from './workers/report.worker.js';
import { startForecastWorker } from './workers/forecast.worker.js';
import { startScheduledWorker } from './workers/scheduled.worker.js';
import { createServer } from 'node:http';
import { createSocketServer, closeSocketServer } from './shared/realtime/socketServer.js';

/**
 * Worker process entrypoint. Distinct from `server.ts` so long-running
 * background work (PDF rendering, AI calls, email dispatch) cannot steal
 * CPU from the request-serving API process (SDD §5.6).
 */
async function bootstrap(): Promise<void> {
  await connectDatabase();
  await connectRedis();
  // Redis adapter forwards worker events to clients connected to API instances.
  createSocketServer(createServer());

  const workers = [
    startEmailWorker(),
    startReportWorker(),
    startForecastWorker(),
    startScheduledWorker(),
  ];
  // A stable scheduler ID prevents multiple worker processes registering duplicate timers.
  if (env.LOW_STOCK_MONITOR_ENABLED) {
    await scheduledQueue.upsertJobScheduler(
      'inventory-low-stock-monitor',
      {
        every: env.LOW_STOCK_MONITOR_INTERVAL_MS,
      },
      { name: 'scheduled.inventory.low_stock_monitor', data: {} },
    );
  } else {
    await scheduledQueue.removeJobScheduler('inventory-low-stock-monitor');
  }

  logger.info(
    { event: 'worker.ready', queues: workers.map((w) => w.name) },
    'BullMQ workers running',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, event: 'worker.shutdown_start' }, 'worker shutting down');
    try {
      await Promise.all(workers.map((w) => w.close()));
      await closeSocketServer();
      await closeQueues();
      await disconnectRedis();
      await disconnectDatabase();
      logger.info({ event: 'worker.shutdown_complete' }, 'worker shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.fatal({ err, event: 'worker.shutdown_error' }, 'worker shutdown error');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err, event: 'worker.uncaught_exception' }, 'uncaught exception in worker');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason, event: 'worker.unhandled_rejection' }, 'unhandled rejection in worker');
    void shutdown('unhandledRejection');
  });
}

bootstrap().catch((err: unknown) => {
  logger.fatal({ err, event: 'worker.bootstrap_failed' }, 'worker bootstrap failed');
  process.exit(1);
});
