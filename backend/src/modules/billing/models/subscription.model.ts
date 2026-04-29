import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';

export type SubscriptionTier = 'trial' | 'starter' | 'growth' | 'enterprise';
export const SUBSCRIPTION_TIERS: readonly SubscriptionTier[] = [
  'trial',
  'starter',
  'growth',
  'enterprise',
] as const;

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'cancelled'
  | 'incomplete'
  | 'incomplete_expired';

export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'trialing',
  'active',
  'past_due',
  'cancelled',
  'incomplete',
  'incomplete_expired',
] as const;

export type PaymentGateway = 'stripe' | 'sslcommerz';

export interface PaymentMethod {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

export interface SubscriptionDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  scheduledTier: SubscriptionTier | null;
  gateway: PaymentGateway;
  gatewayCustomerId: string | null;
  gatewaySubscriptionId: string | null;
  paymentMethod: PaymentMethod | null;
  seats: number;
  createdAt: Date;
  updatedAt: Date;
}

export type SubscriptionHydrated = HydratedDocument<SubscriptionDoc>;

const paymentMethodSchema = new Schema<PaymentMethod>(
  {
    brand: { type: String, required: true, trim: true, maxlength: 32 },
    last4: { type: String, required: true, trim: true, maxlength: 4 },
    expMonth: { type: Number, required: true, min: 1, max: 12 },
    expYear: { type: Number, required: true, min: 2024, max: 2100 },
  },
  { _id: false },
);

const subscriptionSchema = new Schema<SubscriptionDoc>(
  {
    tier: { type: String, enum: SUBSCRIPTION_TIERS, default: 'trial' },
    status: { type: String, enum: SUBSCRIPTION_STATUSES, default: 'trialing', index: true },
    trialEndsAt: { type: Date, default: null },
    currentPeriodStart: { type: Date, required: true, default: () => new Date() },
    currentPeriodEnd: { type: Date, required: true },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    scheduledTier: { type: String, enum: [...SUBSCRIPTION_TIERS, null], default: null },
    gateway: { type: String, enum: ['stripe', 'sslcommerz'], required: true },
    gatewayCustomerId: { type: String, default: null, trim: true, maxlength: 128 },
    gatewaySubscriptionId: { type: String, default: null, trim: true, maxlength: 128 },
    paymentMethod: { type: paymentMethodSchema, default: null },
    seats: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

subscriptionSchema.index({ tenantId: 1 }, { unique: true });
subscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });
subscriptionSchema.index(
  { gatewaySubscriptionId: 1 },
  { unique: true, partialFilterExpression: { gatewaySubscriptionId: { $type: 'string' } } },
);
subscriptionSchema.index(
  { gatewayCustomerId: 1 },
  { partialFilterExpression: { gatewayCustomerId: { $type: 'string' } } },
);

subscriptionSchema.plugin(tenancyPlugin);
subscriptionSchema.plugin(auditPlugin);

export const Subscription = model<SubscriptionDoc>('Subscription', subscriptionSchema);
