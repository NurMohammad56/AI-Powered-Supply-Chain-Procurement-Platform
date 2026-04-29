import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { redisCache } from './config/redis.js';
import { mongoose } from './config/database.js';
import { requestId } from './shared/middleware/requestId.js';
import { requestLogger } from './shared/middleware/requestLogger.js';
import { rateLimitUnauthenticated } from './shared/middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './shared/middleware/errorHandler.js';
import { buildApiRouter } from './routes.js';
import { ErrorCodes } from './shared/errors/errorCodes.js';

/**
 * Express app FACTORY (SDD §3.1). Returns a configured app without
 * binding to a network port. The split between `app.ts` (factory) and
 * `server.ts` (process bootstrap) is what lets integration tests run
 * the full middleware chain through Supertest with no port at all.
 */
export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // ---- Global middleware (order matters - SDD §3.3.1) ----
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (env.CORS_ORIGINS.includes(origin)) return cb(null, true);
        cb(new Error('CORS_ORIGIN_REJECTED'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Request-Id',
        'X-CSRF',
        'Idempotency-Key',
      ],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  );
  app.use(cookieParser());
  app.use(requestId);
  app.use(requestLogger);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(rateLimitUnauthenticated);

  // ---- Health endpoints (SDD §12.2) ----
  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      version: env.GIT_SHA.slice(0, 7),
    });
  });

  app.get('/readyz', async (_req: Request, res: Response) => {
    const checks = await Promise.allSettled([
      mongoose.connection.readyState === 1 ? Promise.resolve(true) : Promise.resolve(false),
      redisCache.ping().then((r) => r === 'PONG'),
    ]);
    const [mongoOk, redisOk] = checks.map((c) => c.status === 'fulfilled' && c.value === true);
    const ok = mongoOk && redisOk;
    res.status(ok ? 200 : 503).json({
      ok,
      deps: { mongo: mongoOk, redis: redisOk },
    });
  });

  // ---- API routes ----
  app.use('/api/v1', buildApiRouter());

  // ---- 404 + error handler (last) ----
  app.use((req, res) => {
    res.status(404).json({
      error: {
        code: ErrorCodes.NOT_FOUND,
        message: `Route not found: ${req.method} ${req.path}`,
        ...(req.id ? { requestId: req.id } : {}),
      },
    });
  });
  void notFoundHandler;
  app.use(errorHandler);

  logger.debug({ event: 'app.created' }, 'Express app constructed');
  return app;
}
