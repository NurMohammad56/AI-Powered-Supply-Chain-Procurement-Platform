import { env } from '../config/env.js';
import { Worker, type Job } from 'bullmq';
import { Types } from 'mongoose';
import { tenantStorage } from '../shared/db/tenancyPlugin.js';
import { EmailDelivery } from '../modules/notification/models/emailDelivery.model.js';
import { StockBalance } from '../modules/inventory/models/stockBalance.model.js';

import { redisQueue } from '../config/redis.js';
import { logger } from '../config/logger.js';
import { emailClient } from '../shared/email/resend.client.js';
import { QueueNames, type EmailJobMap } from '../shared/queue/jobTypes.js';

export function startEmailWorker(): Worker<EmailJobMap['email.send']> {
  const worker = new Worker<EmailJobMap['email.send']>(
    QueueNames.Email,
    async (job: Job<EmailJobMap['email.send']>) => {
      if (job.data.tenantId && job.data.lowStockBalanceId && job.data.lowStockEpisodeId) {
        const skip = await tenantStorage.run(
          { tenantId: new Types.ObjectId(job.data.tenantId) },
          async () => {
            const delivered = await EmailDelivery.exists({
              bullJobId: `${env.QUEUE_PREFIX}:${job.id}`,
              state: 'delivered',
            });
            if (delivered) return true;
            if (job.data.lowStockBalanceId && job.data.lowStockEpisodeId) {
              return !(await StockBalance.exists({
                _id: job.data.lowStockBalanceId,
                lowStockEpisodeId: job.data.lowStockEpisodeId,
                lowStockSince: { $type: 'date' },
              }));
            }
            return false;
          },
        );
        if (skip) return { skipped: true };
      }
      const log = logger.child({
        worker: QueueNames.Email,
        jobId: job.id,
        attempt: job.attemptsMade + 1,
      });
      log.info(
        { event: 'email.start', to: job.data.to, subject: job.data.subject },
        'sending email',
      );
      const saveDelivery = async (
        state: 'queued' | 'delivered' | 'failed',
        providerId: string | null = null,
        error: string | null = null,
      ) => {
        if (!job.data.tenantId) return;
        await tenantStorage.run({ tenantId: new Types.ObjectId(job.data.tenantId) }, () =>
          EmailDelivery.findOneAndUpdate(
            { bullJobId: `${env.QUEUE_PREFIX}:${job.id}` },
            {
              $set: {
                to: Array.isArray(job.data.to) ? job.data.to[0] : job.data.to,
                subject: job.data.subject,
                template: job.data.template ?? null,
                state,
                providerId,
                error,
                attempts: job.attemptsMade + 1,
                lastAttemptAt: new Date(),
                metadata: { recipients: job.data.to },
              },
            },
            { upsert: true, runValidators: true },
          ).exec(),
        );
      };
      await saveDelivery('queued');

      const result = await emailClient.send({
        to: job.data.to,
        subject: job.data.subject,
        html: job.data.html,
        text: job.data.text,
        replyTo: job.data.replyTo,
        tags: job.data.tags,
      });

      if (!result.delivered) {
        await saveDelivery('failed', result.id, result.error ?? 'Email send failed');
        log.warn({ event: 'email.failed', error: result.error }, 'email send failed');
        throw new Error(result.error ?? 'email send failed');
      }
      await saveDelivery('delivered', result.id);

      log.info({ event: 'email.sent', providerId: result.id }, 'email sent');
      return { providerId: result.id };
    },
    {
      connection: redisQueue,
      prefix: env.QUEUE_PREFIX,
      concurrency: 8,
    },
  );

  worker.on('failed', (job, err) => {
    logger.warn(
      {
        worker: QueueNames.Email,
        jobId: job?.id,
        attempts: job?.attemptsMade,
        err,
      },
      'email job failed',
    );
  });

  worker.on('completed', (job) => {
    logger.debug({ worker: QueueNames.Email, jobId: job.id }, 'email job completed');
  });

  return worker;
}
