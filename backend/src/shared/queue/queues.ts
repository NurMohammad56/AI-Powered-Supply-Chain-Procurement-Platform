import { Queue, QueueEvents, type JobsOptions } from 'bullmq';

import { redisQueue } from '../../config/redis.js';
import { logger } from '../../config/logger.js';
import { QueueNames, type EmailJobMap, type ForecastJobMap, type ReportJobMap, type ScheduledJobMap } from './jobTypes.js';

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

function buildQueue<TPayload>(name: string, opts: Partial<JobsOptions> = {}): Queue<TPayload> {
  return new Queue<TPayload>(name, {
    connection: redisQueue,
    defaultJobOptions: { ...defaultJobOptions, ...opts },
  });
}

// Email queue: 5 retries with longer backoff, terminal failure flips
// emailDeliveries.state in the worker (FR-NOT-08).
export const emailQueue = buildQueue<EmailJobMap[keyof EmailJobMap]>(QueueNames.Email, {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5 * 60_000 },
});

// Report queue: 2 retries, modest backoff.
export const reportQueue = buildQueue<ReportJobMap[keyof ReportJobMap]>(QueueNames.Report, {
  attempts: 2,
  backoff: { type: 'exponential', delay: 5 * 60_000 },
});

// Forecast queue: 2 retries (LLM calls are flaky), modest backoff.
export const forecastQueue = buildQueue<ForecastJobMap[keyof ForecastJobMap]>(QueueNames.Forecast, {
  attempts: 2,
  backoff: { type: 'exponential', delay: 60_000 },
});

// Scheduled queue: cron-like jobs (quote expiry, PO overdue) enqueued
// with `delay: <ms>`. Single retry; failures usually mean the upstream
// row no longer exists, which is fine.
export const scheduledQueue = buildQueue<ScheduledJobMap[keyof ScheduledJobMap]>(QueueNames.Scheduled, {
  attempts: 1,
});

const emailEvents = new QueueEvents(QueueNames.Email, { connection: redisQueue });
const reportEvents = new QueueEvents(QueueNames.Report, { connection: redisQueue });
const forecastEvents = new QueueEvents(QueueNames.Forecast, { connection: redisQueue });
const scheduledEvents = new QueueEvents(QueueNames.Scheduled, { connection: redisQueue });

emailEvents.on('failed', ({ jobId, failedReason }) => {
  logger.warn({ queue: QueueNames.Email, jobId, failedReason }, 'email job failed');
});
reportEvents.on('failed', ({ jobId, failedReason }) => {
  logger.warn({ queue: QueueNames.Report, jobId, failedReason }, 'report job failed');
});
forecastEvents.on('failed', ({ jobId, failedReason }) => {
  logger.warn({ queue: QueueNames.Forecast, jobId, failedReason }, 'forecast job failed');
});
scheduledEvents.on('failed', ({ jobId, failedReason }) => {
  logger.warn({ queue: QueueNames.Scheduled, jobId, failedReason }, 'scheduled job failed');
});

export async function closeQueues(): Promise<void> {
  await Promise.all([
    emailQueue.close().catch(() => undefined),
    reportQueue.close().catch(() => undefined),
    forecastQueue.close().catch(() => undefined),
    scheduledQueue.close().catch(() => undefined),
    emailEvents.close().catch(() => undefined),
    reportEvents.close().catch(() => undefined),
    forecastEvents.close().catch(() => undefined),
    scheduledEvents.close().catch(() => undefined),
  ]);
}

export async function enqueueEmail<K extends keyof EmailJobMap>(
  jobName: K,
  payload: EmailJobMap[K],
  opts: JobsOptions = {},
): Promise<void> {
  await emailQueue.add(jobName, payload, opts);
}

export async function enqueueReport<K extends keyof ReportJobMap>(
  jobName: K,
  payload: ReportJobMap[K],
  opts: JobsOptions = {},
): Promise<void> {
  await reportQueue.add(jobName, payload, opts);
}

export async function enqueueForecast<K extends keyof ForecastJobMap>(
  jobName: K,
  payload: ForecastJobMap[K],
  opts: JobsOptions = {},
): Promise<{ jobId: string }> {
  const job = await forecastQueue.add(jobName, payload, opts);
  return { jobId: job.id ?? '' };
}

export async function enqueueScheduled<K extends keyof ScheduledJobMap>(
  jobName: K,
  payload: ScheduledJobMap[K],
  opts: JobsOptions = {},
): Promise<{ jobId: string }> {
  const job = await scheduledQueue.add(jobName, payload, opts);
  return { jobId: job.id ?? '' };
}
