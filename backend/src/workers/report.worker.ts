import { Worker, type Job } from 'bullmq';

import { redisQueue } from '../config/redis.js';
import { logger } from '../config/logger.js';
import { QueueNames, type ReportJobMap } from '../shared/queue/jobTypes.js';

/**
 * Report worker. The actual analytics + AI narrative generation lands in
 * the reporting module (later prompt). This stub provides the worker
 * skeleton so the queue is consumed and reports already enqueued during
 * development do not pile up on the dead-letter set.
 */
export function startReportWorker(): Worker<ReportJobMap[keyof ReportJobMap]> {
  const worker = new Worker<ReportJobMap[keyof ReportJobMap]>(
    QueueNames.Report,
    async (job: Job<ReportJobMap[keyof ReportJobMap]>) => {
      const log = logger.child({
        worker: QueueNames.Report,
        jobId: job.id,
        jobName: job.name,
        attempt: job.attemptsMade + 1,
      });
      log.info({ event: 'report.start', payload: job.data }, 'report job received');

      switch (job.name) {
        case 'report.weekly_digest':
          // Placeholder: real implementation fans out per tenant with the
          // analytics engine + Puppeteer PDF render (FR-RPT-09).
          log.info({ event: 'report.weekly_digest.stub' }, 'weekly digest stub - implementation pending');
          return { ok: true, kind: 'weekly_digest_stub' };

        case 'report.adhoc':
          log.info({ event: 'report.adhoc.stub' }, 'adhoc report stub - implementation pending');
          return { ok: true, kind: 'adhoc_stub' };

        default:
          throw new Error(`Unknown report job name: ${job.name}`);
      }
    },
    {
      connection: redisQueue,
      concurrency: 2,
    },
  );

  worker.on('failed', (job, err) => {
    logger.warn(
      {
        worker: QueueNames.Report,
        jobId: job?.id,
        jobName: job?.name,
        err,
      },
      'report job failed',
    );
  });

  return worker;
}
