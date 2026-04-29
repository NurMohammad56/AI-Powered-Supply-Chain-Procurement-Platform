import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';

export type EmailDeliveryState = 'queued' | 'delivered' | 'bounced' | 'complained' | 'failed';

export const EMAIL_DELIVERY_STATES: readonly EmailDeliveryState[] = [
  'queued',
  'delivered',
  'bounced',
  'complained',
  'failed',
] as const;

/**
 * Outbound email delivery audit (FR-NOT-07). One document per dispatched
 * email — webhook events from Resend update the `state` field as the
 * provider reports delivery progress.
 */
export interface EmailDeliveryDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  to: string;
  cc: string[];
  subject: string;
  template: string | null;
  providerId: string | null;
  state: EmailDeliveryState;
  attempts: number;
  lastAttemptAt: Date | null;
  bullJobId: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export type EmailDeliveryHydrated = HydratedDocument<EmailDeliveryDoc>;

const emailDeliverySchema = new Schema<EmailDeliveryDoc>(
  {
    to: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    cc: { type: [String], default: [] },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    template: { type: String, default: null, trim: true, maxlength: 80 },
    providerId: { type: String, default: null, trim: true, maxlength: 128 },
    state: { type: String, enum: EMAIL_DELIVERY_STATES, default: 'queued', index: true },
    attempts: { type: Number, default: 0, min: 0 },
    lastAttemptAt: { type: Date, default: null },
    bullJobId: { type: String, default: null, trim: true, maxlength: 64 },
    error: { type: String, default: null, trim: true, maxlength: 2000 },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

emailDeliverySchema.index({ tenantId: 1, state: 1, lastAttemptAt: -1 });
emailDeliverySchema.index({ tenantId: 1, to: 1, createdAt: -1 });
emailDeliverySchema.index(
  { providerId: 1 },
  { unique: true, partialFilterExpression: { providerId: { $type: 'string' } } },
);

emailDeliverySchema.plugin(tenancyPlugin);
emailDeliverySchema.plugin(auditPlugin);

export const EmailDelivery = model<EmailDeliveryDoc>('EmailDelivery', emailDeliverySchema);
