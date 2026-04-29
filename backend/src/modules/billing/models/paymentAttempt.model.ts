import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';
import type { PaymentGateway } from './subscription.model.js';

/**
 * Per-charge attempt audit. One subscription invoice can produce N
 * payment attempts (initial + dunning retries on attempts 1, 3, 5 per
 * FR-BIL-08). Records both successful and failed attempts; the gateway
 * webhook handler upserts based on `gatewayPaymentIntentId`.
 */

export type PaymentAttemptStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'requires_action';

export const PAYMENT_ATTEMPT_STATUSES: readonly PaymentAttemptStatus[] = [
  'pending',
  'succeeded',
  'failed',
  'cancelled',
  'requires_action',
] as const;

export interface PaymentAttemptDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  invoiceId: Types.ObjectId | null;
  subscriptionId: Types.ObjectId | null;
  /** Amount in smallest currency unit (paisa for BDT, cents for USD). */
  amount: number;
  currency: 'BDT' | 'USD';
  gateway: PaymentGateway;
  /** Idempotency-key from the gateway (Stripe payment_intent id / SSL transaction id). */
  gatewayPaymentIntentId: string;
  status: PaymentAttemptStatus;
  attemptNumber: number;
  errorCode: string | null;
  errorMessage: string | null;
  /** Subset of the gateway's response stored for forensic review (PCI-safe fields only). */
  gatewayResponseSummary: Record<string, unknown> | null;
  attemptedAt: Date;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PaymentAttemptHydrated = HydratedDocument<PaymentAttemptDoc>;

const paymentAttemptSchema = new Schema<PaymentAttemptDoc>(
  {
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', default: null },
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', default: null },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ['BDT', 'USD'], required: true },
    gateway: { type: String, enum: ['stripe', 'sslcommerz'], required: true },
    gatewayPaymentIntentId: { type: String, required: true, maxlength: 200 },
    status: {
      type: String,
      enum: PAYMENT_ATTEMPT_STATUSES,
      default: 'pending',
      index: true,
    },
    attemptNumber: { type: Number, required: true, min: 1, default: 1 },
    errorCode: { type: String, default: null, maxlength: 100 },
    errorMessage: { type: String, default: null, maxlength: 1000 },
    gatewayResponseSummary: { type: Schema.Types.Mixed, default: null },
    attemptedAt: { type: Date, required: true, default: () => new Date() },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

paymentAttemptSchema.index(
  { tenantId: 1, gateway: 1, gatewayPaymentIntentId: 1 },
  { unique: true, name: 'tenant_gateway_intent_unique' },
);
paymentAttemptSchema.index({ tenantId: 1, invoiceId: 1, attemptedAt: -1 });
paymentAttemptSchema.index({ tenantId: 1, subscriptionId: 1, attemptedAt: -1 });
paymentAttemptSchema.index({ tenantId: 1, status: 1, attemptedAt: -1 });

paymentAttemptSchema.plugin(tenancyPlugin);
paymentAttemptSchema.plugin(auditPlugin);

export const PaymentAttempt = model<PaymentAttemptDoc>('PaymentAttempt', paymentAttemptSchema);
