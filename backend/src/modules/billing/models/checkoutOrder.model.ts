import { Schema, model, type Types } from 'mongoose';
import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import type { SubscriptionTier } from '../../../shared/auth/types.js';
export interface CheckoutOrderDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  tier: SubscriptionTier;
  amount: number;
  currency: string;
  sessionId: string | null;
  subscriptionId: string | null;
  state: 'pending' | 'paid' | 'expired';
  createdAt: Date;
  updatedAt: Date;
}
const schema = new Schema<CheckoutOrderDoc>(
  {
    tier: { type: String, enum: ['starter', 'growth', 'enterprise'], required: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'usd' },
    sessionId: { type: String, default: null },
    subscriptionId: { type: String, default: null },
    state: { type: String, enum: ['pending', 'paid', 'expired'], default: 'pending' },
  },
  { timestamps: true },
);
schema.index({ tenantId: 1, state: 1 });
schema.index(
  { sessionId: 1 },
  { unique: true, partialFilterExpression: { sessionId: { $type: 'string' } } },
);
schema.plugin(tenancyPlugin);
export const CheckoutOrder = model<CheckoutOrderDoc>('CheckoutOrder', schema);

// Global receipt ledger is only accessed after Stripe signature verification.
const eventSchema = new Schema(
  { _id: String, type: String, tenantId: Schema.Types.ObjectId, processedAt: Date },
  { versionKey: false },
);
export const StripeEventReceipt = model('StripeEventReceipt', eventSchema);
