import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';

/**
 * Per-tenant per-month AI usage roll-up. Updated on every successful
 * pipeline call via `aiUsageRepository.increment(...)`. The tier-based
 * monthly cap is enforced before the LLM call; this collection is the
 * source of truth for "how many tokens has tenant X used this month".
 *
 * `period` is the first day of the calendar month in UTC, stored as a
 * Date so that `{ tenantId, period }` is uniquely indexable and time-
 * range queries are cheap.
 */
export interface AiUsageDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  period: Date;
  /** Token counts (input + output, summed per provider) */
  promptTokens: number;
  completionTokens: number;
  /** Number of forecast calls executed this period */
  forecastCalls: number;
  /** Number of report generations this period */
  reportCalls: number;
  /** Approximate cost in USD micros (1e6 = $1) for cheap integer arithmetic */
  estimatedCostMicroUsd: number;
  /** When the soft alert was last fired for this tenant+period */
  alertedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AiUsageHydrated = HydratedDocument<AiUsageDoc>;

const aiUsageSchema = new Schema<AiUsageDoc>(
  {
    period: { type: Date, required: true, index: true },
    promptTokens: { type: Number, default: 0, min: 0 },
    completionTokens: { type: Number, default: 0, min: 0 },
    forecastCalls: { type: Number, default: 0, min: 0 },
    reportCalls: { type: Number, default: 0, min: 0 },
    estimatedCostMicroUsd: { type: Number, default: 0, min: 0 },
    alertedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Compound (tenantId, period) is the operational lookup; the inline
// `index: true` on the `period` field provides the standalone index
// for cross-tenant period queries (e.g. cron rollups). No standalone
// `period` index here — Mongoose would warn about duplication.
aiUsageSchema.index({ tenantId: 1, period: 1 }, { unique: true });

aiUsageSchema.plugin(tenancyPlugin);

export const AiUsage = model<AiUsageDoc>('AiUsage', aiUsageSchema);

/**
 * Returns the first millisecond of the current UTC calendar month for a
 * given clock instant. Used as the primary key of the usage roll-up.
 */
export function periodKey(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}
