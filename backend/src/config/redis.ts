import Redis, { type RedisOptions } from 'ioredis';
import { env } from './env.js';
import { logger } from './logger.js';

function buildOptions(role: string): RedisOptions {
  return {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectionName: `scp-${role}`,
    lazyConnect: true,
    tls: env.REDIS_TLS ? {} : undefined,
  };
}

function createClient(role: string): Redis {
  const client = new Redis(env.REDIS_URL, buildOptions(role));

  client.on('connect', () => logger.info({ role, event: 'redis.connect' }, 'Redis connecting'));

  client.on('ready', () => logger.info({ role, event: 'redis.ready' }, 'Redis ready'));

  client.on('error', (err) => logger.error({ err, role, event: 'redis.error' }, 'Redis error'));

  return client;
}

// Create clients (NO MANUAL connect needed)
export const redisCache = createClient('cache');
export const redisQueue = createClient('queue');
export const redisSockPub = createClient('sock-pub');
export const redisSockSub = createClient('sock-sub');

/**
 * Connect all Redis clients safely
 */
export async function connectRedis(): Promise<void> {
  await Promise.all([
    redisCache.connect(),
    redisQueue.connect(),
    redisSockPub.connect(),
    redisSockSub.connect(),
  ]);
}

/**
 * Graceful shutdown
 */
export async function disconnectRedis(): Promise<void> {
  await Promise.all([
    redisCache.quit().catch(() => {}),
    redisQueue.quit().catch(() => {}),
    redisSockPub.quit().catch(() => {}),
    redisSockSub.quit().catch(() => {}),
  ]);
}

/**
 * Health check
 */
export async function pingRedis(): Promise<boolean> {
  try {
    const res = await redisCache.ping();
    return res === 'PONG';
  } catch {
    return false;
  }
}
