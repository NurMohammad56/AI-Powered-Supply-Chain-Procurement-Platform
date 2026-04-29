/**
 * Discriminated job payload types per BullMQ queue.
 * Producers (services) and consumers (workers) share these definitions
 * end-to-end so that a job mismatch is a compile error.
 */

export const QueueNames = {
  Email: 'email',
  Report: 'report',
  Forecast: 'forecast',
  Pdf: 'pdf',
  Webhook: 'webhook',
  LowStock: 'low_stock',
  Accuracy: 'accuracy',
  Scheduled: 'scheduled',
} as const;

export type QueueName = (typeof QueueNames)[keyof typeof QueueNames];

// ---------- Email queue ----------
export interface SendEmailJob {
  emailDeliveryId?: string;
  tenantId?: string;
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  template?: string;
  replyTo?: string;
  tags?: Record<string, string>;
}

export type EmailJobName = 'email.send';
export type EmailJobMap = {
  'email.send': SendEmailJob;
};

// ---------- Report queue ----------
export interface GenerateWeeklyDigestJob {
  tenantId: string;
  weekStart: string;
  weekEnd: string;
}
export interface GenerateAdHocReportJob {
  tenantId: string;
  reportKind: 'inventory_turnover' | 'spend' | 'cash_flow';
  rangeFrom: string;
  rangeTo: string;
  requestedBy: string;
}

export type ReportJobName = 'report.weekly_digest' | 'report.adhoc';
export type ReportJobMap = {
  'report.weekly_digest': GenerateWeeklyDigestJob;
  'report.adhoc': GenerateAdHocReportJob;
};

// ---------- Scheduled queue ----------
/**
 * The scheduled queue carries all "fire later" cron-style jobs that
 * don't fit a single domain queue: quote-response expiry, PO delivery
 * overdue checks, and any future tenant-scoped cron fan-out.
 */
export interface QuotationExpiryCheckJob {
  tenantId: string;
  quotationId: string;
}

export interface PoDeliveryOverdueCheckJob {
  tenantId: string;
  poId: string;
}

export type ScheduledJobName =
  | 'scheduled.quotation.expiry_check'
  | 'scheduled.po.delivery_overdue_check';

export type ScheduledJobMap = {
  'scheduled.quotation.expiry_check': QuotationExpiryCheckJob;
  'scheduled.po.delivery_overdue_check': PoDeliveryOverdueCheckJob;
};

// ---------- Forecast queue ----------
export interface ForecastSingleItemJob {
  tenantId: string;
  itemId: string;
  /** When set, the worker emits a per-item progress update on the batch. */
  batchJobId?: string;
  /** Total items in the parent batch, for progress reporting. */
  batchTotal?: number;
  /** Index of this item within the batch (0-based). */
  batchIndex?: number;
  /** User who triggered the job, for socket fan-out + audit. */
  requestedBy: string;
}

export interface ForecastBatchJob {
  tenantId: string;
  /** When omitted, all non-archived items in the tenant are forecast. */
  itemIds?: string[];
  requestedBy: string;
}

export type ForecastJobName = 'forecast.single_item' | 'forecast.batch';
export type ForecastJobMap = {
  'forecast.single_item': ForecastSingleItemJob;
  'forecast.batch': ForecastBatchJob;
};
