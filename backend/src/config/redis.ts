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
 * Connect all four Redis clients, idempotently.
 *
 * Why idempotent: BullMQ's `Queue` / `QueueEvents` constructors take a
 * reference to our `redisQueue` instance and call `.connect()` on it
 * internally as soon as the module that creates them is loaded. Because
 * `server.ts` imports `shared/queue/queues.ts` at the top (for
 * `closeQueues`), those queues are constructed BEFORE `bootstrap()`
 * calls `connectRedis()`. A second `.connect()` on an already-connecting
 * client throws `Redis is already connecting/connected`.
 *
 * `safeConnect` inspects the ioredis status and only calls `.connect()`
 * when the client is in a connectable state (`wait` / `end`). For
 * clients already past that point, we wait for the `ready` event (or
 * resolve immediately if already ready).
 */
export async function connectRedis(): Promise<void> {
  await Promise.all([
    safeConnect(redisCache, 'cache'),
    safeConnect(redisQueue, 'queue'),
    safeConnect(redisSockPub, 'sock-pub'),
    safeConnect(redisSockSub, 'sock-sub'),
  ]);
}

async function safeConnect(client: Redis, role: string): Promise<void> {
  // ioredis status state machine:
  //   wait | connecting | connect | ready | reconnecting | close | end
  const status = client.status;
  if (status === 'ready') return;
  if (status === 'wait' || status === 'end') {
    await client.connect();
    return;
  }
  // 'connecting' | 'connect' | 'reconnecting' | 'close' — wait for ready.
  await new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      client.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      client.off('ready', onReady);
      logger.error({ err, role, event: 'redis.connect_failed' }, 'Redis connect failed');
      reject(err);
    };
    client.once('ready', onReady);
    client.once('error', onError);
  });
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
