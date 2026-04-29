import { Worker, type Job } from 'bullmq';
import { Types } from 'mongoose';

import { redisQueue } from '../config/redis.js';
import { logger } from '../config/logger.js';
import { QueueNames, type ForecastJobMap, type ForecastSingleItemJob, type ForecastBatchJob } from '../shared/queue/jobTypes.js';
import { aiService } from '../modules/ai/ai.service.js';
import { tenantRoom, SocketEvents } from '../shared/realtime/events.js';
import { getIo } from '../shared/realtime/socketServer.js';
import { enqueueEmail } from '../shared/queue/queues.js';
import { Item } from '../modules/ai/../inventory/models/item.model.js';
import type { ItemDoc } from '../modules/inventory/models/item.model.js';
import { Factory } from '../modules/auth/models/factory.model.js';
import { User } from '../modules/auth/models/user.model.js';
import type { TenantContext } from '../shared/auth/types.js';
import type { ForecastHorizonDays } from '../modules/ai/models/forecast.model.js';

/**
 * Forecast worker. Two job kinds:
 *
 *   - `forecast.single_item`: one item, one horizon. Used by ad-hoc UI
 *     re-runs from the dashboard. Returns the persisted forecast id.
 *
 *   - `forecast.batch`: fans out across many items for a tenant.
 *     Internally re-enqueues per-item work to keep the per-call concurrency
 *     small (LLM rate limits) while still presenting the user with live
 *     progress via Socket.io.
 *
 * Concurrency is intentionally low (3) because Groq has a 30 RPM limit on
 * free tiers and we want one batch to not starve other tenants' single
 * forecasts. Production tuning should come from observed P99 latency.
 */
const WORKER_CONCURRENCY = 3;

export function startForecastWorker(): Worker<ForecastJobMap[keyof ForecastJobMap]> {
  const worker = new Worker<ForecastJobMap[keyof ForecastJobMap]>(
    QueueNames.Forecast,
    async (job: Job<ForecastJobMap[keyof ForecastJobMap]>) => {
      const log = logger.child({
        worker: QueueNames.Forecast,
        jobId: job.id,
        jobName: job.name,
        attempt: job.attemptsMade + 1,
      });

      switch (job.name) {
        case 'forecast.single_item':
          return handleSingleItem(job as Job<ForecastSingleItemJob>, log);
        case 'forecast.batch':
          return handleBatch(job as Job<ForecastBatchJob>, log);
        default:
          throw new Error(`Unknown forecast job name: ${job.name}`);
      }
    },
    {
      connection: redisQueue,
      concurrency: WORKER_CONCURRENCY,
    },
  );

  worker.on('failed', (job, err) => {
    logger.warn(
      {
        worker: QueueNames.Forecast,
        jobId: job?.id,
        jobName: job?.name,
        err,
      },
      'forecast job failed',
    );
  });

  return worker;
}

interface JobLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
  debug: (obj: Record<string, unknown>, msg?: string) => void;
}

async function handleSingleItem(job: Job<ForecastSingleItemJob>, log: JobLogger): Promise<{
  ok: true;
  forecastId: string;
}> {
  const { tenantId, itemId, requestedBy, batchJobId, batchTotal, batchIndex } = job.data;
  log.info({ event: 'forecast.single.start', tenantId, itemId }, 'forecast job received');

  const ctx = await buildTenantContextForJob({ tenantId, userId: requestedBy });
  const horizon: ForecastHorizonDays = 30;
  const itemObjectId = new Types.ObjectId(itemId);

  if (batchJobId !== undefined && batchTotal !== undefined && batchIndex !== undefined) {
    emitBatchProgress({
      tenantId,
      payload: {
        batchJobId,
        itemId,
        index: batchIndex,
        total: batchTotal,
        status: 'started',
      },
    });
  }

  try {
    const created = await aiService.runForecastForItem({
      ctx,
      itemId: itemObjectId,
      horizonDays: horizon,
      // Batch jobs already passed the global rate-limit check at enqueue
      // time; per-item locks would create false negatives mid-batch.
      skipRateLimit: batchJobId !== undefined,
      skipReadCache: false,
    });

    if (batchJobId !== undefined && batchTotal !== undefined && batchIndex !== undefined) {
      emitBatchProgress({
        tenantId,
        payload: {
          batchJobId,
          itemId,
          index: batchIndex,
          total: batchTotal,
          status: 'completed',
        },
      });
    }

    log.info(
      { event: 'forecast.single.complete', forecastId: created._id.toString() },
      'forecast generated',
    );
    return { ok: true, forecastId: created._id.toString() };
  } catch (err) {
    if (batchJobId !== undefined && batchTotal !== undefined && batchIndex !== undefined) {
      emitBatchProgress({
        tenantId,
        payload: {
          batchJobId,
          itemId,
          index: batchIndex,
          total: batchTotal,
          status: 'failed',
        },
      });
    }
    log.error({ err, event: 'forecast.single.failed', tenantId, itemId }, 'forecast failed');
    throw err;
  }
}

async function handleBatch(
  job: Job<ForecastBatchJob>,
  log: JobLogger,
): Promise<{ ok: true; total: number; succeeded: number; failed: number }> {
  const { tenantId, itemIds, requestedBy } = job.data;
  log.info({ event: 'forecast.batch.start', tenantId, count: itemIds?.length ?? 'all' }, 'batch job started');

  const ctx = await buildTenantContextForJob({ tenantId, userId: requestedBy });
  const tenantObjectId = new Types.ObjectId(tenantId);

  let items: ItemDoc[];
  if (itemIds && itemIds.length > 0) {
    items = await Item.find({
      tenantId: tenantObjectId,
      _id: { $in: itemIds.map((id) => new Types.ObjectId(id)) },
      archivedAt: null,
    })
      .lean<ItemDoc[]>()
      .exec();
  } else {
    items = await Item.find({ tenantId: tenantObjectId, archivedAt: null })
      .lean<ItemDoc[]>()
      .exec();
  }

  const total = items.length;
  let succeeded = 0;
  let failed = 0;
  const startedAt = Date.now();
  const batchJobId = job.id ?? '';

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    const itemId = item._id.toString();
    emitBatchProgress({
      tenantId,
      payload: {
        batchJobId,
        itemId,
        index,
        total,
        status: 'started',
      },
    });
    try {
      await aiService.runForecastForItem({
        ctx,
        itemId: item._id,
        horizonDays: 30,
        skipRateLimit: true,
        skipReadCache: true,
      });
      succeeded += 1;
      emitBatchProgress({
        tenantId,
        payload: {
          batchJobId,
          itemId,
          index,
          total,
          status: 'completed',
        },
      });
    } catch (err) {
      failed += 1;
      log.warn(
        { err, event: 'forecast.batch.item_failed', itemId, index },
        'item-level forecast failed; continuing batch',
      );
      emitBatchProgress({
        tenantId,
        payload: {
          batchJobId,
          itemId,
          index,
          total,
          status: 'failed',
        },
      });
    }
    // BullMQ progress reporting (1..100). Useful for queue UIs.
    const pct = Math.round(((index + 1) / total) * 100);
    await job.updateProgress(pct).catch(() => undefined);
  }

  const durationMs = Date.now() - startedAt;
  emitBatchCompleted({ tenantId, batchJobId, total, succeeded, failed, durationMs });

  // Email the requester a summary so they have a record outside the dashboard.
  await sendBatchSummaryEmail({ tenantId, requestedBy, total, succeeded, failed, durationMs }).catch(
    (err: unknown) => log.warn({ err, event: 'forecast.batch.email_failed' }, 'batch summary email failed'),
  );

  log.info(
    { event: 'forecast.batch.complete', total, succeeded, failed, durationMs },
    'batch job complete',
  );
  return { ok: true, total, succeeded, failed };
}

async function buildTenantContextForJob(args: {
  tenantId: string;
  userId: string;
}): Promise<TenantContext> {
  const tenantObjectId = new Types.ObjectId(args.tenantId);
  const userObjectId = new Types.ObjectId(args.userId);
  const factory = await Factory.findById(tenantObjectId).lean().exec();
  if (!factory) {
    throw new Error(`Tenant not found: ${args.tenantId}`);
  }
  const user = await User.findOne({ _id: userObjectId, tenantId: tenantObjectId }).lean().exec();
  if (!user) {
    throw new Error(`Requesting user not found: ${args.userId}`);
  }
  return {
    tenantId: tenantObjectId,
    userId: userObjectId,
    role: user.role,
    subscriptionTier: factory.subscriptionTier,
    seats: factory.seats ?? 0,
    features: new Set<string>(factory.features ?? []),
    requestId: `forecast-job:${args.tenantId}:${Date.now()}`,
  };
}

function emitBatchProgress(args: {
  tenantId: string;
  payload: {
    batchJobId: string;
    itemId: string;
    index: number;
    total: number;
    status: 'started' | 'completed' | 'failed';
  };
}): void {
  try {
    const io = getIo();
    io.to(tenantRoom(args.tenantId)).emit(SocketEvents.AiForecastBatchProgress, args.payload);
  } catch {
    // Worker may run before the socket is initialised in some deploys.
  }
}

function emitBatchCompleted(args: {
  tenantId: string;
  batchJobId: string;
  total: number;
  succeeded: number;
  failed: number;
  durationMs: number;
}): void {
  try {
    const io = getIo();
    io.to(tenantRoom(args.tenantId)).emit(SocketEvents.AiForecastBatchCompleted, {
      batchJobId: args.batchJobId,
      total: args.total,
      succeeded: args.succeeded,
      failed: args.failed,
      durationMs: args.durationMs,
    });
  } catch {
    // ignore
  }
}

async function sendBatchSummaryEmail(args: {
  tenantId: string;
  requestedBy: string;
  total: number;
  succeeded: number;
  failed: number;
  durationMs: number;
}): Promise<void> {
  const user = await User.findOne({
    _id: new Types.ObjectId(args.requestedBy),
    tenantId: new Types.ObjectId(args.tenantId),
  })
    .select({ email: 1, name: 1 })
    .lean()
    .exec();
  if (!user || !user.email) return;
  const html = `
    <h2>Batch demand forecast complete</h2>
    <p>Hi ${escapeHtml(user.name ?? 'there')},</p>
    <p>Your batch demand forecast has finished running. Here's the summary:</p>
    <ul>
      <li>Total items processed: <strong>${args.total}</strong></li>
      <li>Succeeded: <strong>${args.succeeded}</strong></li>
      <li>Failed: <strong>${args.failed}</strong></li>
      <li>Duration: <strong>${(args.durationMs / 1000).toFixed(1)}s</strong></li>
    </ul>
    <p>Forecasts are visible in your dashboard under AI &gt; Forecasts.</p>
  `;
  await enqueueEmail('email.send', {
    tenantId: args.tenantId,
    to: user.email,
    subject: `Batch forecast complete - ${args.succeeded}/${args.total} items`,
    html,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
