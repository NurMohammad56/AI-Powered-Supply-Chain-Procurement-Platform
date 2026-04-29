import type { RequestHandler } from 'express';
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import RedisStore, { type SendCommandFn } from 'rate-limit-redis';

import { redisCache } from '../../config/redis.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { TooManyRequestsError } from '../errors/HttpErrors.js';
import { ErrorCodes } from '../errors/errorCodes.js';

const sendCommand: SendCommandFn = (...args: string[]) =>
  redisCache.call(args[0] as string, ...args.slice(1)) as ReturnType<SendCommandFn>;

function buildStore(prefix: string): RedisStore {
  return new RedisStore({ sendCommand, prefix });
}

const handler = (_req: unknown, _res: unknown, next: (err?: unknown) => void): void => {
  next(new TooManyRequestsError(ErrorCodes.RATE_LIMITED));
};

export const rateLimitUnauthenticated: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000,
  limit: env.RATE_LIMIT_UNAUTH_PER_MIN,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: buildStore('rl:ip:unauth:'),
  keyGenerator: (req) => req.ip ?? 'unknown',
  handler,
});

export const rateLimitAuthenticated: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000,
  limit: env.RATE_LIMIT_AUTH_PER_MIN,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: buildStore('rl:ip:auth:'),
  keyGenerator: (req) => req.ip ?? 'unknown',
  handler,
});

export const rateLimitTenant: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000,
  limit: env.RATE_LIMIT_TENANT_PER_MIN,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: buildStore('rl:tenant:'),
  keyGenerator: (req) => req.context?.tenantId.toString() ?? req.ip ?? 'unknown',
  handler,
});

/**
 * Tighter limit on the login endpoint, keyed by submitted email so a
 * brute-force from a single IP across many emails cannot exhaust an
 * entire IP budget. 10 attempts / 15 minutes (FR-AUTH-09 / SDD §9.4).
 */
export const rateLimitLogin: RateLimitRequestHandler = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: buildStore('rl:login:'),
  keyGenerator: (req) => {
    const body = req.body as { email?: unknown } | undefined;
    const email = typeof body?.email === 'string' ? body.email.toLowerCase() : '';
    return email || req.ip || 'unknown';
  },
  handler,
});

/**
 * Refresh endpoint: 12 attempts/min keyed by IP. Excess attempts indicate
 * a token-theft race; the auth.service additionally trips reuse detection
 * on any presented-but-rotated token.
 */
export const rateLimitRefresh: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: buildStore('rl:refresh:'),
  keyGenerator: (req) => req.ip ?? 'unknown',
  handler,
});

/**
 * Auth-endpoint hard cap (Prompt 06): 5 attempts per 15 minutes per IP,
 * applied to /auth/login and /auth/forgot-password. Stricter than
 * rateLimitLogin because it is per-IP (not per-email) and so blocks a
 * password-spray across many accounts from one host.
 */
export const rateLimitAuthSensitive: RateLimitRequestHandler = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: buildStore('rl:auth-sensitive:'),
  keyGenerator: (req) => req.ip ?? 'unknown',
  handler,
});

/**
 * Webhook router: high-volume cap (1000/min per IP) since legitimate
 * gateway traffic can spike during settlement runs. Signature
 * verification in the webhook handler is the real authn gate; the rate
 * limiter only protects against pathological flooding.
 */
export const rateLimitWebhook: RateLimitRequestHandler = rateLimit({
  windowMs: 60_000,
  limit: 1000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: buildStore('rl:webhook:'),
  keyGenerator: (req) => req.ip ?? 'unknown',
  handler,
});

/**
 * Sliding-window rate limiter using Redis sorted sets. More accurate
 * than the fixed-window `express-rate-limit` for low-frequency,
 * cost-bearing endpoints (AI calls, file uploads) where a burst at the
 * window boundary would otherwise effectively double the budget.
 *
 * Algorithm:
 *   - Each request adds a ZADD entry keyed at `now` (microseconds) to
 *     the sorted-set bucket.
 *   - We trim entries older than `windowMs` with ZREMRANGEBYSCORE.
 *   - The current count is ZCARD; if >= limit we reject.
 *   - The bucket key has TTL = 2 * windowMs so abandoned buckets self-evict.
 *
 * All operations execute in a single MULTI pipeline so the read+trim+add
 * sequence is atomic across concurrent requests.
 */
export interface SlidingWindowOptions {
  windowMs: number;
  limit: number;
  prefix: string;
  keyGenerator: (req: import('express').Request) => string;
}

export function slidingWindowLimiter(opts: SlidingWindowOptions): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        const key = `${opts.prefix}${opts.keyGenerator(req)}`;
        const now = Date.now();
        const cutoff = now - opts.windowMs;
        // Use a unique member per request (now + crypto rand) to avoid
        // ZADD treating two simultaneous calls as a single entry.
        const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
        const pipeline = redisCache.multi();
        pipeline.zremrangebyscore(key, 0, cutoff);
        pipeline.zadd(key, now, member);
        pipeline.zcard(key);
        pipeline.pexpire(key, opts.windowMs * 2);
        const results = await pipeline.exec();
        // Result of ZCARD is the third command (index 2).
        const cardEntry = results?.[2];
        const count =
          Array.isArray(cardEntry) && typeof cardEntry[1] === 'number' ? cardEntry[1] : 0;
        if (count > opts.limit) {
          // We added one before checking; the count is post-add. Allow
          // exactly `limit` per window.
          return next(new TooManyRequestsError(ErrorCodes.RATE_LIMITED));
        }
        return next();
      } catch (err) {
        // Rate-limiter must NEVER block on its own backend failure.
        logger.warn({ err, event: 'ratelimit.sliding.fail_open', prefix: opts.prefix }, 'sliding rate limiter degraded; failing open');
        return next();
      }
    })();
  };
}

/**
 * Per-tenant AI call limit: 10 calls per minute. Cost-control gate that
 * sits *in addition* to the per-call quota check inside `aiService`.
 * The quota gate enforces the monthly cap; this limiter prevents a
 * dashboard pathology (e.g. infinite-loop "regenerate" click) from
 * draining hourly cost in seconds.
 */
export const rateLimitAi: RequestHandler = slidingWindowLimiter({
  windowMs: 60_000,
  limit: 10,
  prefix: 'rl:ai:tenant:',
  keyGenerator: (req) => req.context?.tenantId.toString() ?? req.ip ?? 'unknown',
});

/**
 * File upload limit: 20 uploads per hour per tenant. Applies to any
 * route that accepts a multipart body or signs an upload URL.
 */
export const rateLimitFileUpload: RequestHandler = slidingWindowLimiter({
  windowMs: 60 * 60_000,
  limit: 20,
  prefix: 'rl:upload:tenant:',
  keyGenerator: (req) => req.context?.tenantId.toString() ?? req.ip ?? 'unknown',
});
