import type { RequestHandler } from 'express';

import { redisCache } from '../../config/redis.js';
import { logger } from '../../config/logger.js';

/**
 * Idempotency-Key middleware (SDD §3.3.2 step 6).
 *
 * For POST endpoints with side effects, allow the client to supply an
 * `Idempotency-Key` header. If the same (tenant, key) is replayed within
 * 24 hours, return the cached response instead of re-running the handler.
 *
 * The middleware caches only the response body and status; controllers
 * are still responsible for ensuring their primary write path is itself
 * idempotent at the database level (CAS, unique indexes, etc.).
 */
const TTL_SECONDS = 24 * 60 * 60;
const HEADER = 'idempotency-key';

interface CachedResponse {
  status: number;
  body: unknown;
}

export const idempotencyKey: RequestHandler = async (req, res, next) => {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH') {
    return next();
  }

  const key = req.header(HEADER);
  if (!key) return next();
  if (key.length < 8 || key.length > 255) return next();

  const tenant = req.context?.factoryId?.toString() ?? 'anon';
  const redisKey = `idem:${tenant}:${key}`;

  try {
    const hit = await redisCache.get(redisKey);
    if (hit) {
      const cached = JSON.parse(hit) as CachedResponse;
      res.status(cached.status).json(cached.body);
      return;
    }
  } catch (err) {
    logger.warn({ err, redisKey }, 'idempotency cache read failed - proceeding');
  }

  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    redisCache
      .set(redisKey, JSON.stringify({ status: res.statusCode, body }), 'EX', TTL_SECONDS)
      .catch((err: unknown) => logger.warn({ err, redisKey }, 'idempotency cache write failed'));
    return originalJson(body);
  };

  next();
};
