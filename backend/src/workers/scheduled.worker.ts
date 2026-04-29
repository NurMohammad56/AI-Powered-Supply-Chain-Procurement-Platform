import { Worker, type Job } from 'bullmq';
import { Types } from 'mongoose';

import { redisQueue } from '../config/redis.js';
import { logger } from '../config/logger.js';
import { QueueNames, type ScheduledJobMap } from '../shared/queue/jobTypes.js';
import { QuotationRequest } from '../modules/supplier/models/quotationRequest.model.js';
import { PurchaseOrder } from '../modules/po/models/purchaseOrder.model.js';
import { notifyDeliveryOverdue } from '../modules/po/po.notifications.js';

/**
 * Scheduled worker for "fire later" cron-style jobs:
 *
 *   - quotation.expiry_check: when an open RFQ passes its `validUntil`
 *     timestamp, mark it `expired` (status -> 'closed') and audit-log
 *     the transition. Idempotent.
 *
 *   - po.delivery_overdue_check: 7 days past expectedDeliveryAt, if
 *     the PO is still in `sent` or `partially_received`, fan out alert
 *     emails to managers. Re-runs the check 7 days later for a follow-up.
 */

const OVERDUE_FOLLOWUP_DAYS = 7;

export function startScheduledWorker(): Worker<ScheduledJobMap[keyof ScheduledJobMap]> {
  const worker = new Worker<ScheduledJobMap[keyof ScheduledJobMap]>(
    QueueNames.Scheduled,
    async (job: Job<ScheduledJobMap[keyof ScheduledJobMap]>) => {
      const log = logger.child({
        worker: QueueNames.Scheduled,
        jobId: job.id,
        jobName: job.name,
      });
      switch (job.name) {
        case 'scheduled.quotation.expiry_check': {
          const data = job.data as ScheduledJobMap['scheduled.quotation.expiry_check'];
          return handleQuotationExpiry({ ...data, log });
        }
        case 'scheduled.po.delivery_overdue_check': {
          const data = job.data as ScheduledJobMap['scheduled.po.delivery_overdue_check'];
          return handlePoOverdue({ ...data, log });
        }
        default:
          throw new Error(`Unknown scheduled job name: ${String(job.name)}`);
      }
    },
    {
      connection: redisQueue,
      concurrency: 4,
    },
  );

  worker.on('failed', (job, err) => {
    logger.warn(
      { worker: QueueNames.Scheduled, jobId: job?.id, jobName: job?.name, err },
      'scheduled job failed',
    );
  });

  return worker;
}

interface HandlerLog {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  debug: (obj: Record<string, unknown>, msg?: string) => void;
}

async function handleQuotationExpiry(args: {
  tenantId: string;
  quotationId: string;
  log: HandlerLog;
}): Promise<{ ok: true; expired: boolean }> {
  const tenantObjectId = new Types.ObjectId(args.tenantId);
  const quotationObjectId = new Types.ObjectId(args.quotationId);
  const result = await QuotationRequest.updateOne(
    {
      _id: quotationObjectId,
      tenantId: tenantObjectId,
      status: 'open',
      validUntil: { $lte: new Date() },
    },
    { $set: { status: 'closed' } },
  ).exec();
  const expired = (result.modifiedCount ?? 0) > 0;
  args.log.info(
    { event: 'scheduled.quotation.expiry_check', quotationId: args.quotationId, expired },
    expired ? 'quotation expired' : 'quotation expiry no-op (not open or not yet expired)',
  );
  return { ok: true, expired };
}

async function handlePoOverdue(args: {
  tenantId: string;
  poId: string;
  log: HandlerLog;
}): Promise<{ ok: true; alerted: boolean }> {
  const tenantObjectId = new Types.ObjectId(args.tenantId);
  const poObjectId = new Types.ObjectId(args.poId);
  const po = await PurchaseOrder.findOne({ _id: poObjectId, tenantId: tenantObjectId }).lean().exec();
  if (!po) {
    args.log.debug({ event: 'scheduled.po.overdue.missing', poId: args.poId }, 'PO no longer exists');
    return { ok: true, alerted: false };
  }
  // Only alert when the PO is still awaiting full receipt.
  if (po.state !== 'sent' && po.state !== 'partially_received') {
    args.log.debug(
      { event: 'scheduled.po.overdue.terminal_state', poId: args.poId, state: po.state },
      'PO no longer awaiting delivery',
    );
    return { ok: true, alerted: false };
  }
  const expectedAt = po.expectedDeliveryAt.getTime();
  const daysOverdue = Math.floor((Date.now() - expectedAt) / (24 * 60 * 60 * 1000));
  if (daysOverdue < OVERDUE_FOLLOWUP_DAYS) {
    // Should not happen if scheduling is correct, but guard anyway.
    args.log.debug(
      { event: 'scheduled.po.overdue.early', daysOverdue, poId: args.poId },
      'overdue check fired early; skipping',
    );
    return { ok: true, alerted: false };
  }
  await notifyDeliveryOverdue({ po, daysOverdue });
  args.log.info(
    { event: 'scheduled.po.overdue.alerted', poId: args.poId, daysOverdue },
    'overdue alert sent',
  );
  return { ok: true, alerted: true };
}
