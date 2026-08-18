import { randomBytes } from 'node:crypto';

import { logger } from '../../config/logger.js';
import { recordAudit, AuditActions } from '../../shared/audit/index.js';
import type { TenantContext } from '../../shared/auth/types.js';
import { authRepository } from '../auth/auth.repository.js';
import {
  BadRequestError,
  InternalError,
  NotFoundError,
  NotImplementedError,
} from '../../shared/errors/HttpErrors.js';
import { billingRepository } from './billing.repository.js';
import type { SubscriptionDoc } from './models/subscription.model.js';
import type { InvoiceDoc } from './models/invoice.model.js';
import {
  initiateSslCommerzTransaction,
  validateSslCommerzTransaction,
} from './sslcommerz.client.js';
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

const PLAN_BY_TIER = new Map<string, PlanView>(PLAN_CATALOGUE.map((plan) => [plan.tier, plan]));
const BILLING_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

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

function pagedView<T, V>(
  page: { rows: T[]; nextCursor: string | null; hasMore: boolean; limit: number },
  mapper: (row: T) => V,
) {
  return {
    rows: page.rows.map(mapper),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    limit: page.limit,
  };
}

function genReference(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

function parseBody(raw: Buffer): Record<string, string> {
  const text = raw.toString('utf8').trim();
  if (!text) return {};

  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)]),
      );
    }
  } catch {
    // Fall through to form parsing.
  }

  const params = new URLSearchParams(text);
  return Object.fromEntries(params.entries());
}

function tierPrice(tier: string): PlanView {
  const plan = PLAN_BY_TIER.get(tier);
  if (!plan) throw new BadRequestError('INVALID_TIER', `Unsupported tier: ${tier}`);
  return plan;
}

function normalizeUrl(input: string): string {
  return input.replace(/\/$/, '');
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

  async createCheckoutSession(
    ctx: TenantContext,
    input: CreateCheckoutSessionRequest,
  ): Promise<CheckoutSessionView> {
    if (input.gateway === 'stripe') {
      throw new NotImplementedError('billing.stripe', 'Stripe is disabled in this deployment');
    }

    const plan = tierPrice(input.tier);
    if (plan.tier === 'trial') {
      throw new BadRequestError('INVALID_TIER', 'Trial tier cannot be purchased');
    }

    const [factory, user] = await Promise.all([
      authRepository.findFactoryById(ctx.tenantId),
      authRepository.findUserById(ctx.userId),
    ]);
    if (!factory || !user) throw new NotFoundError();

    const now = new Date();
    const existingSubscription = await billingRepository.findSubscriptionForTenant(ctx.tenantId);
    const tranId = genReference('SCB');

    const subscription = await billingRepository.upsertSubscription(ctx.tenantId, {
      tier: existingSubscription?.tier ?? 'trial',
      status: existingSubscription?.status ?? 'incomplete',
      trialEndsAt: existingSubscription?.trialEndsAt ?? null,
      currentPeriodStart: existingSubscription?.currentPeriodStart ?? now,
      currentPeriodEnd:
        existingSubscription?.currentPeriodEnd ?? new Date(now.getTime() + BILLING_PERIOD_MS),
      cancelAtPeriodEnd: false,
      scheduledTier: input.tier as SubscriptionDoc['scheduledTier'],
      gateway: 'sslcommerz',
      gatewayCustomerId: user.email,
      gatewaySubscriptionId: tranId,
      paymentMethod: null,
      seats: existingSubscription?.seats ?? 0,
    });
    if (!subscription) throw new InternalError('BILLING_SUBSCRIPTION_UPSERT_FAILED');

    const invoiceNumber = genReference('INV');
    const invoice = await billingRepository.upsertInvoiceByGatewayId(ctx.tenantId, tranId, {
      subscriptionId: subscription._id,
      number: invoiceNumber,
      amountSubtotal: plan.monthlyPrice.amount,
      amountTax: 0,
      amountTotal: plan.monthlyPrice.amount,
      currency: plan.monthlyPrice.currency as InvoiceDoc['currency'],
      status: 'open',
      pdfUrl: null,
      issuedAt: now,
      paidAt: null,
      dueAt: null,
      gateway: 'sslcommerz',
      gatewayInvoiceId: tranId,
      gatewayPaymentIntentId: tranId,
      failureReason: null,
    });
    if (!invoice) throw new InternalError('BILLING_INVOICE_UPSERT_FAILED');

    const attempt = await billingRepository.upsertPaymentAttemptByGatewayId(ctx.tenantId, tranId, {
      invoiceId: invoice._id,
      subscriptionId: subscription._id,
      amount: invoice.amountTotal,
      currency: invoice.currency,
      gateway: 'sslcommerz',
      gatewayPaymentIntentId: tranId,
      status: 'pending',
      attemptNumber: 1,
      errorCode: null,
      errorMessage: null,
      gatewayResponseSummary: null,
      attemptedAt: now,
      resolvedAt: null,
    });
    if (!attempt) throw new InternalError('BILLING_ATTEMPT_UPSERT_FAILED');

    const failUrl = input.failUrl ?? input.cancelUrl;
    const ipnUrl = input.ipnUrl ?? null;
    const redirectBase = normalizeUrl(input.successUrl);

    const session = await initiateSslCommerzTransaction({
      totalAmount: invoice.amountTotal,
      currency: invoice.currency,
      tranId,
      productCategory: 'software',
      successUrl: redirectBase,
      failUrl,
      cancelUrl: input.cancelUrl,
      ipnUrl,
      customerName: user.fullName,
      customerEmail: user.email,
      customerPhone: '01700000000',
      customerAddress: factory.name,
      customerCity: 'Dhaka',
      customerCountry: 'Bangladesh',
      shippingMethod: 'NO',
      numOfItem: 1,
      valueA: ctx.tenantId.toString(),
      valueB: invoice._id.toString(),
      valueC: input.tier,
      valueD: ctx.userId.toString(),
    });

    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.BillingSubscriptionCreated,
      target: { kind: 'subscription', id: subscription._id },
      payload: {
        gateway: 'sslcommerz',
        tier: input.tier,
        invoiceId: invoice._id.toString(),
        tranId,
        sessionKey: session.sessionKey,
      },
      requestId: ctx.requestId,
    });

    void billingRepository
      .upsertInvoiceByGatewayId(ctx.tenantId, tranId, {
        gatewayPaymentIntentId: session.sessionKey ?? tranId,
      })
      .catch((err: unknown) =>
        logger.warn(
          { err, event: 'billing.invoice_session_update_failed', tranId },
          'failed to persist SSLCommerz session key',
        ),
      );

    void billingRepository
      .upsertPaymentAttemptByGatewayId(ctx.tenantId, tranId, {
        gatewayResponseSummary: {
          gateway: 'sslcommerz',
          sessionKey: session.sessionKey,
          gatewayPageUrl: session.gatewayPageUrl,
        },
      })
      .catch((err: unknown) =>
        logger.warn(
          { err, event: 'billing.attempt_session_update_failed', tranId },
          'failed to persist SSLCommerz response summary',
        ),
      );

    return { redirectUrl: session.gatewayPageUrl };
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
    const fromRank = SUBSCRIPTION_TIER_RANK[sub.tier] ?? 0;
    const toRank = SUBSCRIPTION_TIER_RANK[input.tier] ?? 0;
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action:
        toRank > fromRank
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

  async ingestWebhook(args: {
    gateway: 'stripe' | 'sslcommerz';
    rawBody: Buffer;
    signature: string | null;
  }): Promise<{ accepted: boolean }> {
    if (args.gateway === 'stripe') {
      throw new NotImplementedError(
        'billing.stripe.webhook',
        'Stripe webhook handling is disabled',
      );
    }

    const payload = parseBody(args.rawBody);
    const tranId = payload.tran_id ?? payload.tranId ?? null;
    const sessionKey = payload.sessionkey ?? payload.sessionKey ?? null;
    const valId = payload.val_id ?? payload.valId ?? null;

    if (!tranId && !sessionKey && !valId) {
      return { accepted: true };
    }

    const invoiceRef = tranId ? await billingRepository.findInvoiceByGatewayIdGlobal(tranId) : null;
    if (!invoiceRef) {
      logger.warn(
        { event: 'billing.sslcommerz_webhook_unmatched', tranId, sessionKey, valId },
        'SSLCommerz webhook did not match any invoice',
      );
      return { accepted: true };
    }

    return billingRepository.withScope(invoiceRef.tenantId, async () => {
      const [invoice, subscription] = await Promise.all([
        billingRepository.findInvoiceByGatewayId(tranId ?? invoiceRef.gatewayInvoiceId ?? ''),
        billingRepository.findSubscriptionForTenant(invoiceRef.tenantId),
      ]);

      if (!invoice || !subscription) {
        throw new InternalError('BILLING_WEBHOOK_LOOKUP_FAILED');
      }

      const validation = await validateSslCommerzTransaction({ sessionKey, tranId, valId });
      const status = (validation.status ?? '').toUpperCase();
      const amountOk =
        validation.amount === null || Number(validation.amount) === Number(invoice.amountTotal);
      const currencyOk =
        validation.currency === null || validation.currency.toUpperCase() === invoice.currency;
      const isSuccess =
        (status === 'VALID' || status === 'VALIDATED' || status === 'SUCCESS') &&
        amountOk &&
        currencyOk;

      if (isSuccess) {
        const paidAt = new Date();
        const nextTier = subscription.scheduledTier ?? subscription.tier;
        await billingRepository.upsertSubscription(invoiceRef.tenantId, {
          tier: nextTier,
          status: 'active',
          scheduledTier: null,
          gateway: 'sslcommerz',
          gatewaySubscriptionId: tranId ?? subscription.gatewaySubscriptionId,
          paymentMethod: null,
          seats: PLAN_BY_TIER.get(nextTier)?.seatLimit ?? subscription.seats,
        });
        await billingRepository.upsertInvoiceByGatewayId(
          invoiceRef.tenantId,
          tranId ?? invoice.number,
          {
            status: 'paid',
            paidAt,
            gatewayPaymentIntentId: tranId ?? invoice.gatewayPaymentIntentId,
            failureReason: null,
          },
        );
        await billingRepository.upsertPaymentAttemptByGatewayId(
          invoiceRef.tenantId,
          tranId ?? invoice.gatewayPaymentIntentId ?? invoice.number,
          {
            invoiceId: invoice._id,
            subscriptionId: subscription._id,
            amount: invoice.amountTotal,
            currency: invoice.currency,
            gateway: 'sslcommerz',
            gatewayPaymentIntentId: tranId ?? invoice.gatewayPaymentIntentId ?? invoice.number,
            status: 'succeeded',
            resolvedAt: paidAt,
            errorCode: null,
            errorMessage: null,
            gatewayResponseSummary: {
              ...validation.raw,
            },
          },
        );

        void recordAudit({
          tenantId: invoiceRef.tenantId,
          actorUserId: null,
          actorRole: 'system',
          action: AuditActions.BillingPaymentSucceeded,
          target: { kind: 'invoice', id: invoice._id },
          payload: {
            tranId,
            sessionKey,
            valId,
            amount: validation.amount,
            currency: validation.currency,
          },
        });
        return { accepted: true };
      }

      const failureReason =
        validation.raw.failed_reason ??
        validation.raw.errorReason ??
        validation.raw.risk_title ??
        validation.raw.riskTitle ??
        validation.status ??
        'payment_failed';

      await Promise.all([
        billingRepository.upsertInvoiceByGatewayId(invoiceRef.tenantId, tranId ?? invoice.number, {
          status: 'failed',
          failureReason: String(failureReason),
          gatewayPaymentIntentId: tranId ?? invoice.gatewayPaymentIntentId,
        }),
        billingRepository.upsertPaymentAttemptByGatewayId(
          invoiceRef.tenantId,
          tranId ?? invoice.gatewayPaymentIntentId ?? invoice.number,
          {
            invoiceId: invoice._id,
            subscriptionId: subscription._id,
            amount: invoice.amountTotal,
            currency: invoice.currency,
            gateway: 'sslcommerz',
            gatewayPaymentIntentId: tranId ?? invoice.gatewayPaymentIntentId ?? invoice.number,
            status: 'failed',
            resolvedAt: new Date(),
            errorCode: 'SSL_COMMERZ_VALIDATION_FAILED',
            errorMessage: String(failureReason),
            gatewayResponseSummary: {
              ...validation.raw,
            },
          },
        ),
      ]);

      void recordAudit({
        tenantId: invoiceRef.tenantId,
        actorUserId: null,
        actorRole: 'system',
        action: AuditActions.BillingPaymentFailed,
        target: { kind: 'invoice', id: invoice._id },
        payload: {
          tranId,
          sessionKey,
          valId,
          reason: String(failureReason),
        },
      });
      return { accepted: true };
    });
  }
}

const SUBSCRIPTION_TIER_RANK: Record<string, number> = {
  trial: 0,
  starter: 1,
  growth: 2,
  enterprise: 3,
};

export const billingService = new BillingService();
