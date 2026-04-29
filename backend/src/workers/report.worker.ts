import { Worker, type Job } from 'bullmq';
import { Types } from 'mongoose';

import { redisQueue } from '../config/redis.js';
import { logger } from '../config/logger.js';
import { QueueNames, type ReportJobMap } from '../shared/queue/jobTypes.js';
import { generateWeeklyReport } from '../modules/ai/reportGenerator.js';

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
        case 'report.weekly_digest': {
          const data = job.data as ReportJobMap['report.weekly_digest'];
          const result = await generateWeeklyReport({
            tenantId: new Types.ObjectId(data.tenantId),
            weekStart: new Date(data.weekStart),
            weekEnd: new Date(data.weekEnd),
          });
          log.info(
            {
              event: 'report.weekly_digest.complete',
              tenantId: data.tenantId,
              pdfRendered: result.pdfRendered,
              emailSent: result.emailSent,
              provider: result.provider,
            },
            'weekly digest generated',
          );
          return { ok: true, kind: 'weekly_digest', emailSent: result.emailSent, pdfRendered: result.pdfRendered };
        }

        case 'report.adhoc':
          // Adhoc analytics reports use the rpt aggregations layer
          // directly; the AI narrative is only added for the weekly
          // digest. See rpt.service.ts.
          log.info({ event: 'report.adhoc.stub' }, 'adhoc report stub - analytics only, no AI narrative');
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
