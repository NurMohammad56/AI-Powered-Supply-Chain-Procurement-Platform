import type { SubscriptionTier } from '../../shared/auth/types.js';
export type Feature =
  | 'core_inventory'
  | 'core_suppliers'
  | 'core_po'
  | 'basic_reports'
  | 'ai_forecast'
  | 'advanced_reports';
const core: Feature[] = ['core_inventory', 'core_suppliers', 'core_po', 'basic_reports'];
const growth: Feature[] = [...core, 'ai_forecast', 'advanced_reports'];
export const PLANS: Record<
  SubscriptionTier,
  {
    tier: SubscriptionTier;
    monthlyPrice: { amount: number; currency: 'USD' };
    features: Feature[];
    seatLimit: number;
  }
> = {
  trial: {
    tier: 'trial',
    monthlyPrice: { amount: 0, currency: 'USD' },
    features: growth,
    seatLimit: 10,
  },
  starter: {
    tier: 'starter',
    monthlyPrice: { amount: 49, currency: 'USD' },
    features: core,
    seatLimit: 5,
  },
  growth: {
    tier: 'growth',
    monthlyPrice: { amount: 149, currency: 'USD' },
    features: growth,
    seatLimit: 20,
  },
  enterprise: {
    tier: 'enterprise',
    monthlyPrice: { amount: 499, currency: 'USD' },
    features: growth,
    seatLimit: 100,
  },
};
export const TRIAL_MS = 14 * 86400_000;
