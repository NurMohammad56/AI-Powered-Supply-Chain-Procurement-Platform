import { z } from 'zod';

import { cursorQuerySchema } from '../../shared/utils/pagination.js';
import { SUBSCRIPTION_TIERS } from './models/subscription.model.js';

export const CreateCheckoutSessionRequestSchema = z.object({
  tier: z.enum(SUBSCRIPTION_TIERS as unknown as [string, ...string[]]),
  gateway: z.enum(['stripe', 'sslcommerz']),
  successUrl: z.string().url().max(2048),
  cancelUrl: z.string().url().max(2048),
});
export type CreateCheckoutSessionRequest = z.infer<typeof CreateCheckoutSessionRequestSchema>;

export const ChangeSubscriptionRequestSchema = z.object({
  tier: z.enum(SUBSCRIPTION_TIERS as unknown as [string, ...string[]]),
});
export type ChangeSubscriptionRequest = z.infer<typeof ChangeSubscriptionRequestSchema>;

export const CancelSubscriptionRequestSchema = z.object({
  cancelImmediately: z.boolean().default(false),
});
export type CancelSubscriptionRequest = z.infer<typeof CancelSubscriptionRequestSchema>;

export const ListInvoicesQuerySchema = cursorQuerySchema.extend({
  status: z.enum(['paid', 'open', 'failed', 'refunded', 'void']).optional(),
});
export type ListInvoicesQuery = z.infer<typeof ListInvoicesQuerySchema>;

export interface SubscriptionView {
  tier: string;
  status: string;
  trialEndsAt: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  scheduledTier: string | null;
  gateway: string;
  seats: number;
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null;
}

export interface InvoiceView {
  id: string;
  number: string;
  amountSubtotal: number;
  amountTax: number;
  amountTotal: number;
  currency: string;
  status: string;
  pdfUrl: string | null;
  issuedAt: string;
  paidAt: string | null;
  dueAt: string | null;
}

export interface CheckoutSessionView {
  redirectUrl: string;
}

export interface PlanView {
  tier: string;
  monthlyPrice: { amount: number; currency: string };
  features: string[];
  seatLimit: number;
}
