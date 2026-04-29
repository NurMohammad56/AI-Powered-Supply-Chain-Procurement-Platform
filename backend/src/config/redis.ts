import { Redis, type RedisOptions } from 'ioredis';

import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Three independent Redis connections per SDD §5.1:
 *   - cache:   application-level cache (cache-aside reads)
 *   - queue:   BullMQ queue and worker connections
 *   - sock:    Socket.io adapter pub/sub
 *
 * Mixing roles on a single connection causes head-of-line blocking and
 * subscription/command interference under load.
 */

function buildOptions(role: string): RedisOptions {
  return {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectionName: `scp-${role}`,
    tls: env.REDIS_TLS ? {} : undefined,
    reconnectOnError: (err) => {
      logger.warn({ err, role, event: 'redis.reconnect' }, 'Redis reconnect on error');
      return true;
    },
  };
}

function createClient(role: 'cache' | 'queue' | 'sock-pub' | 'sock-sub'): Redis {
  const client = new Redis(env.REDIS_URL, buildOptions(role));
  client.on('connect', () => logger.info({ role, event: 'redis.connect' }, 'Redis connected'));
  client.on('ready', () => logger.debug({ role, event: 'redis.ready' }, 'Redis ready'));
  client.on('end', () => logger.warn({ role, event: 'redis.end' }, 'Redis connection ended'));
  client.on('error', (err) => logger.error({ err, role, event: 'redis.error' }, 'Redis error'));
  return client;
}

export const redisCache: Redis = createClient('cache');
export const redisQueue: Redis = createClient('queue');
export const redisSockPub: Redis = createClient('sock-pub');
export const redisSockSub: Redis = createClient('sock-sub');

let connected = false;

export async function connectRedis(): Promise<void> {
  if (connected) return;
  await Promise.all([
    redisCache.connect(),
    redisQueue.connect(),
    redisSockPub.connect(),
    redisSockSub.connect(),
  ]);
  connected = true;
}

export async function disconnectRedis(): Promise<void> {
  if (!connected) return;
  await Promise.all([
    redisCache.quit().catch(() => undefined),
    redisQueue.quit().catch(() => undefined),
    redisSockPub.quit().catch(() => undefined),
    redisSockSub.quit().catch(() => undefined),
  ]);
  connected = false;
}

export async function pingRedis(): Promise<boolean> {
  try {
    const reply = await redisCache.ping();
    return reply === 'PONG';
  } catch {
    return false;
  }
}
