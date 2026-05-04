import { createServer, type Server as HttpServer } from 'node:http';

import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { closeQueues } from './shared/queue/queues.js';
import { closeSocketServer, createSocketServer } from './shared/realtime/socketServer.js';
import { createApp } from './app.js';

/**
 * Process bootstrap (SDD §3.1). Connects to MongoDB and Redis, builds
 * the Express app, attaches Socket.io to the same HTTP server, binds to
 * the port, and installs graceful-shutdown signal handlers.
 */
async function bootstrap(): Promise<void> {
  await connectDatabase();
  await connectRedis();

  const app = createApp();
  const httpServer: HttpServer = createServer(app);
  createSocketServer(httpServer);

  await new Promise<void>((resolve) => {
    httpServer.listen(env.PORT, () => {
      logger.info(
        { port: env.PORT, env: env.NODE_ENV, event: 'server.listening' },
        'API server listening',
      );
      resolve();
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, event: 'server.shutdown_start' }, 'graceful shutdown initiated');

    const SHUTDOWN_GRACE_MS = 30_000;
    const forceTimer = setTimeout(() => {
      logger.fatal({ event: 'server.shutdown_force' }, 'forcing exit after grace period');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceTimer.unref();

    try {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await closeSocketServer();
      await closeQueues();
      await disconnectRedis();
      await disconnectDatabase();
      logger.info({ event: 'server.shutdown_complete' }, 'shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.fatal({ err, event: 'server.shutdown_error' }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err, event: 'server.uncaught_exception' }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason, event: 'server.unhandled_rejection' }, 'unhandled rejection');
    void shutdown('unhandledRejection');
  });
}

bootstrap().catch((err: unknown) => {
  logger.fatal({ err, event: 'server.bootstrap_failed' }, 'bootstrap failed');
  process.exit(1);
});
