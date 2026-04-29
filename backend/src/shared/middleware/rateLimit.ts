import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import RedisStore, { type SendCommandFn } from 'rate-limit-redis';

import { redisCache } from '../../config/redis.js';
import { env } from '../../config/env.js';
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
