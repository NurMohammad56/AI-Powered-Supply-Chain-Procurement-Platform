import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Worker } from 'bullmq';
import { spawn } from 'node:child_process';

const realSuite = process.env.RUN_REAL_INTEGRATION === '1' ? describe : describe.skip;

realSuite('Real Atlas, Redis, SMTP, R2, AI and payment sandbox regression', () => {
  let server: Server;
  let closeSocket: () => Promise<void>;
  let workers: Worker[] = [];
  beforeAll(async () => {
    process.loadEnvFile('.env.presentation');
    process.env.LOG_LEVEL = 'error';
    process.env.REGRESSION_EMBEDDED = '1';
    process.env.QUEUE_PREFIX = `coverage-${Date.now()}`;
    const { connectDatabase } = await import('./config/database.js');
    const { connectRedis } = await import('./config/redis.js');
    const { createApp } = await import('./app.js');
    const { createSocketServer, closeSocketServer } =
      await import('./shared/realtime/socketServer.js');
    await connectDatabase();
    await connectRedis();
    const { startEmailWorker } = await import('./workers/email.worker.js');
    const { startForecastWorker } = await import('./workers/forecast.worker.js');
    const { startReportWorker } = await import('./workers/report.worker.js');
    const { startScheduledWorker } = await import('./workers/scheduled.worker.js');
    workers = [
      startEmailWorker(),
      startForecastWorker(),
      startReportWorker(),
      startScheduledWorker(),
    ];
    server = createServer(createApp());
    createSocketServer(server);
    closeSocket = closeSocketServer;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.REGRESSION_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  }, 60000);
  afterAll(async () => {
    delete process.env.REGRESSION_BASE_URL;
    await Promise.all(workers.map((worker) => worker.close()));
    await closeSocket?.();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    const { closeQueues } = await import('./shared/queue/queues.js');
    const { disconnectRedis } = await import('./config/redis.js');
    const { disconnectDatabase } = await import('./config/database.js');
    await closeQueues();
    await disconnectRedis();
    await disconnectDatabase();
    delete process.env.REGRESSION_EMBEDDED;
  });
  it('passes real API and persistence invariants against the instrumented application', async () => {
    const scriptPath = '../scripts/real-regression.ts';
    const runner = (await import(scriptPath)) as { regressionDone: Promise<unknown> };
    await runner.regressionDone;
    const result = JSON.parse(await readFile('artifacts/real-regression-results.json', 'utf8')) as {
      failed: number;
      passed: number;
      results: unknown[];
    };
    expect(result.failed).toBe(0);
    expect(result.passed).toBeGreaterThan(100);
  }, 600000);
  it('validates actual Stripe Checkout for every paid plan and signed webhook replay', async () => {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--env-file=.env.presentation', 'scripts/run-stripe-test.mjs'],
        { env: { ...process.env }, stdio: 'pipe' },
      );
      child.once('error', reject);
      child.once('exit', resolve);
    });
    expect(code).toBe(0);
    const result = JSON.parse(
      await readFile('artifacts/stripe-subscription-test-results.json', 'utf8'),
    ) as {
      passed: boolean;
    };
    expect(result.passed).toBe(true);
  }, 900000);
  it('enforces Redis token revocation without rejecting a newly issued token in the same second', async () => {
    const { randomUUID } = await import('node:crypto');
    const { redisCache } = await import('./config/redis.js');
    const { denylistJti, denylistAllForUser, isAccessTokenDenied } =
      await import('./shared/security/tokenDenylist.js');
    const userId = randomUUID(),
      jti = randomUUID(),
      issuedAtMs = Date.now() - 100;
    const args = { userId, jti, issuedAtSec: Math.floor(issuedAtMs / 1000), issuedAtMs };
    try {
      expect(await isAccessTokenDenied(args)).toBe(false);
      await denylistAllForUser(userId);
      expect(await isAccessTokenDenied(args)).toBe(true);
      expect(await isAccessTokenDenied({ ...args, issuedAtMs: Date.now() + 100 })).toBe(false);
      expect(await isAccessTokenDenied({ userId, jti, issuedAtSec: 0 })).toBe(true);
      await redisCache.set(`auth:deny:user:${userId}`, 'not-a-number');
      expect(await isAccessTokenDenied(args)).toBe(false);
      await denylistJti(jti, new Date(Date.now() + 60000));
      expect(await isAccessTokenDenied(args)).toBe(true);
      await denylistJti('', new Date());
      await denylistAllForUser('');
    } finally {
      await redisCache.del(`auth:deny:user:${userId}`, `auth:deny:jti:${jti}`);
    }
  });
});
