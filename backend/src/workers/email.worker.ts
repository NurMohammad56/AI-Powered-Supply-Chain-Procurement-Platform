import { Worker, type Job } from 'bullmq';

import { redisQueue } from '../config/redis.js';
import { logger } from '../config/logger.js';
import { emailClient } from '../shared/email/resend.client.js';
import { QueueNames, type EmailJobMap } from '../shared/queue/jobTypes.js';

export function startEmailWorker(): Worker<EmailJobMap['email.send']> {
  const worker = new Worker<EmailJobMap['email.send']>(
    QueueNames.Email,
    async (job: Job<EmailJobMap['email.send']>) => {
      const log = logger.child({
        worker: QueueNames.Email,
        jobId: job.id,
        attempt: job.attemptsMade + 1,
      });
      log.info({ event: 'email.start', to: job.data.to, subject: job.data.subject }, 'sending email');

      const result = await emailClient.send({
        to: job.data.to,
        subject: job.data.subject,
        html: job.data.html,
        text: job.data.text,
        replyTo: job.data.replyTo,
        tags: job.data.tags,
      });

      if (!result.delivered) {
        log.warn({ event: 'email.failed', error: result.error }, 'email send failed');
        throw new Error(result.error ?? 'email send failed');
      }

      log.info({ event: 'email.sent', providerId: result.id }, 'email sent');
      return { providerId: result.id };
    },
    {
      connection: redisQueue,
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
