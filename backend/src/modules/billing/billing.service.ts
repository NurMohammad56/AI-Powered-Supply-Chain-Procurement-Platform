import { NotFoundError, NotImplementedError } from '../../shared/errors/HttpErrors.js';
import { recordAudit, AuditActions } from '../../shared/audit/index.js';
import type { TenantContext } from '../../shared/auth/types.js';
import type { Page } from '../../shared/utils/pagination.js';
import { billingRepository } from './billing.repository.js';
import type { SubscriptionDoc } from './models/subscription.model.js';
import type { InvoiceDoc } from './models/invoice.model.js';
import type {
  CancelSubscriptionRequest,
  ChangeSubscriptionRequest,
  CheckoutSessionView,
  CreateCheckoutSessionRequest,
  InvoiceView,
  ListInvoicesQuery,
  PlanView,
  SubscriptionView,
} from './billing.dto.js';

const PLAN_CATALOGUE: PlanView[] = [
  {
    tier: 'trial',
    monthlyPrice: { amount: 0, currency: 'USD' },
    features: ['core_inventory', 'core_suppliers', 'core_po', '14_day_trial'],
    seatLimit: 3,
  },
  {
    tier: 'starter',
    monthlyPrice: { amount: 49, currency: 'USD' },
    features: ['core_inventory', 'core_suppliers', 'core_po', 'basic_reports'],
    seatLimit: 5,
  },
  {
    tier: 'growth',
    monthlyPrice: { amount: 149, currency: 'USD' },
    features: [
      'core_inventory',
      'core_suppliers',
      'core_po',
      'ai_forecast',
      'advanced_reports',
      'webhooks',
    ],
    seatLimit: 20,
  },
  {
    tier: 'enterprise',
    monthlyPrice: { amount: 499, currency: 'USD' },
    features: [
      'core_inventory',
      'core_suppliers',
      'core_po',
      'ai_forecast',
      'advanced_reports',
      'webhooks',
      'sso',
      'audit_export',
    ],
    seatLimit: 100,
  },
];

function toSubscriptionView(s: SubscriptionDoc): SubscriptionView {
  return {
    tier: s.tier,
    status: s.status,
    trialEndsAt: s.trialEndsAt ? s.trialEndsAt.toISOString() : null,
    currentPeriodStart: s.currentPeriodStart.toISOString(),
    currentPeriodEnd: s.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    scheduledTier: s.scheduledTier,
    gateway: s.gateway,
    seats: s.seats,
    paymentMethod: s.paymentMethod
      ? {
          brand: s.paymentMethod.brand,
          last4: s.paymentMethod.last4,
          expMonth: s.paymentMethod.expMonth,
          expYear: s.paymentMethod.expYear,
        }
      : null,
  };
}

function toInvoiceView(i: InvoiceDoc): InvoiceView {
  return {
    id: i._id.toString(),
    number: i.number,
    amountSubtotal: i.amountSubtotal,
    amountTax: i.amountTax,
    amountTotal: i.amountTotal,
    currency: i.currency,
    status: i.status,
    pdfUrl: i.pdfUrl,
    issuedAt: i.issuedAt.toISOString(),
    paidAt: i.paidAt ? i.paidAt.toISOString() : null,
    dueAt: i.dueAt ? i.dueAt.toISOString() : null,
  };
}

function pagedView<T, V>(page: Page<T>, mapper: (row: T) => V) {
  return {
    rows: page.rows.map(mapper),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    limit: page.limit,
  };
}

export class BillingService {
  listPlans(): { plans: PlanView[] } {
    return { plans: PLAN_CATALOGUE };
  }

  async getSubscription(ctx: TenantContext): Promise<SubscriptionView> {
    const sub = await billingRepository.findSubscriptionForTenant(ctx.tenantId);
    if (!sub) throw new NotFoundError();
    return toSubscriptionView(sub);
  }

  /**
   * Gateway-specific checkout creation lands when the Stripe / SSLCommerz
   * adapters are wired (later prompt). Returns 501 until then.
   */
  async createCheckoutSession(
    _ctx: TenantContext,
    _input: CreateCheckoutSessionRequest,
  ): Promise<CheckoutSessionView> {
    throw new NotImplementedError(
      'billing.checkout',
      'Gateway adapters (Stripe / SSLCommerz) are not yet wired',
    );
  }

  async changeSubscription(
    ctx: TenantContext,
    input: ChangeSubscriptionRequest,
  ): Promise<SubscriptionView> {
    const sub = await billingRepository.findSubscriptionForTenant(ctx.tenantId);
    if (!sub) throw new NotFoundError();
    const updated = await billingRepository.upsertSubscription(ctx.tenantId, {
      scheduledTier: input.tier as SubscriptionDoc['scheduledTier'],
    });
    if (!updated) throw new NotFoundError();
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action:
        SUBSCRIPTION_TIER_RANK[input.tier] > SUBSCRIPTION_TIER_RANK[sub.tier]
          ? AuditActions.BillingSubscriptionUpgraded
          : AuditActions.BillingSubscriptionDowngraded,
      target: { kind: 'subscription', id: sub._id },
      payload: { from: sub.tier, to: input.tier },
      requestId: ctx.requestId,
    });
    return toSubscriptionView(updated);
  }

  async cancelSubscription(
    ctx: TenantContext,
    input: CancelSubscriptionRequest,
  ): Promise<SubscriptionView> {
    const sub = await billingRepository.findSubscriptionForTenant(ctx.tenantId);
    if (!sub) throw new NotFoundError();
    const updated = await billingRepository.upsertSubscription(ctx.tenantId, {
      cancelAtPeriodEnd: !input.cancelImmediately,
      status: input.cancelImmediately ? 'cancelled' : sub.status,
    });
    if (!updated) throw new NotFoundError();
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.BillingSubscriptionCancelled,
      target: { kind: 'subscription', id: sub._id },
      payload: { immediately: input.cancelImmediately },
      requestId: ctx.requestId,
    });
    return toSubscriptionView(updated);
  }

  async listInvoices(_ctx: TenantContext, query: ListInvoicesQuery) {
    const page = await billingRepository.listInvoices(query);
    return pagedView(page, toInvoiceView);
  }

  /**
   * Webhook ingestion stub - landing point for Stripe/SSLCommerz events.
   * Real signature verification + event dispatch land with the gateway
   * adapters; this stub records the receipt for traceability.
   */
  async ingestWebhook(args: {
    gateway: 'stripe' | 'sslcommerz';
    rawBody: Buffer;
    signature: string | null;
  }): Promise<{ accepted: boolean }> {
    void recordAudit({
      tenantId: null,
      actorUserId: null,
      actorRole: 'system',
      action: 'billing.webhook.received',
      target: { kind: 'webhook', id: null },
      payload: {
        gateway: args.gateway,
        bodyBytes: args.rawBody.length,
        hasSignature: args.signature !== null,
      },
    });
    return { accepted: true };
  }
}

const SUBSCRIPTION_TIER_RANK: Record<string, number> = {
  trial: 0,
  starter: 1,
  growth: 2,
  enterprise: 3,
};

export const billingService = new BillingService();
