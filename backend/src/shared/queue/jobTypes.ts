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
  factoryId?: string;
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
  factoryId: string;
  weekStart: string;
  weekEnd: string;
}
export interface GenerateAdHocReportJob {
  factoryId: string;
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
