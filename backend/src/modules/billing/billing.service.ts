import crypto from 'node:crypto';
import { Types } from 'mongoose';
import type Stripe from 'stripe';
import { mongoose } from '../../config/database.js';
import { env } from '../../config/env.js';
import { redisCache } from '../../config/redis.js';
import { tenantStorage } from '../../shared/db/tenancyPlugin.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../shared/errors/HttpErrors.js';
import type { TenantContext, SubscriptionTier } from '../../shared/auth/types.js';
import { authRepository } from '../auth/auth.repository.js';
import { Factory } from '../auth/models/factory.model.js';
import { User } from '../auth/models/user.model.js';
import { billingRepository } from './billing.repository.js';
import { Subscription, type SubscriptionDoc } from './models/subscription.model.js';
import { CheckoutOrder, StripeEventReceipt } from './models/checkoutOrder.model.js';
import { stripeClient, stripePrice, tierForPrice } from './stripe.client.js';
import { ensureSubscription, resolveAccount, subscriptionAccess } from './access.policy.js';
import { PLANS, TRIAL_MS } from './plans.js';
import type {
  CreateCheckoutSessionRequest,
  ChangeSubscriptionRequest,
  CancelSubscriptionRequest,
  ListInvoicesQuery,
} from './billing.dto.js';

const idOf = (value: string | { id: string } | null | undefined): string | null =>
  typeof value === 'string' ? value : (value?.id ?? null);
function view(sub: SubscriptionDoc) {
  return {
    tier: sub.tier,
    status: sub.status,
    trialEndsAt: sub.trialEndsAt,
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    scheduledTier: sub.scheduledTier,
    gateway: sub.gateway,
    seats: PLANS[sub.tier].seatLimit,
    paymentMethod: sub.paymentMethod,
    accessMode: subscriptionAccess(sub),
    trialRestartCount: sub.trialRestartCount ?? 0,
    lastTrialRestartedAt: sub.lastTrialRestartedAt ?? null,
  };
}
function returnUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== new URL(env.FRONTEND_BASE_URL).origin)
    throw new BadRequestError('INVALID_RETURN_URL', 'Return URL must use FRONTEND_BASE_URL origin');
  return value;
}
async function billingLock<T>(tenantId: Types.ObjectId, fn: () => Promise<T>): Promise<T> {
  const key = `${env.QUEUE_PREFIX}:billing-lock:${tenantId}`,
    token = crypto.randomUUID();
  let acquired = false;
  for (let n = 0; n < 50; n++) {
    if (await redisCache.set(key, token, 'PX', 60_000, 'NX')) {
      acquired = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!acquired)
    throw new ConflictError('BILLING_BUSY', 'Another billing operation is running; retry shortly');
  try {
    return await fn();
  } finally {
    await redisCache.eval(
      "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
      1,
      key,
      token,
    );
  }
}
async function verifiedOwner(ctx: TenantContext) {
  const account = await resolveAccount(ctx);
  if (account.role !== 'owner')
    throw new ForbiddenError('RBAC_CAPABILITY_DENIED', 'Only the company owner manages billing');
  if (!account.emailVerified)
    throw new ForbiddenError('EMAIL_VERIFICATION_REQUIRED', 'Verify your email before checkout');
  if (account.accessMode === 'suspended')
    throw new ForbiddenError('COMPANY_SUSPENDED', 'Company is suspended');
  return account;
}

export class BillingService {
  listPlans() {
    return { plans: Object.values(PLANS), trialDays: 14 };
  }
  async getSubscription(ctx: TenantContext) {
    return view(await ensureSubscription(ctx.tenantId));
  }

  async restartTrial(ctx: TenantContext) {
    await verifiedOwner(ctx);
    return billingLock(ctx.tenantId, async () => {
      const sub = await ensureSubscription(ctx.tenantId);
      if (sub.tier !== 'trial' && subscriptionAccess(sub) === 'full') {
        throw new ConflictError(
          'PAID_SUBSCRIPTION_EXISTS',
          'Cancel the paid subscription before restarting a trial',
        );
      }
      if (sub.gatewaySubscriptionId) {
        if (sub.gateway !== 'stripe' || !sub.gatewaySubscriptionId.startsWith('sub_')) {
          throw new ConflictError(
            'PAID_SUBSCRIPTION_EXISTS',
            'Resolve the existing provider subscription before restarting a trial',
          );
        }
        const remote = await stripeClient().subscriptions.retrieve(sub.gatewaySubscriptionId);
        if (!['canceled', 'incomplete_expired'].includes(remote.status)) {
          throw new ConflictError(
            'PAID_SUBSCRIPTION_EXISTS',
            'Cancel the Stripe subscription first; restarting a trial does not cancel provider billing',
          );
        }
      }
      // Open Checkout URLs must stop working before a new free trial is granted.
      for (const order of await CheckoutOrder.find({ state: 'pending' }).lean().exec()) {
        if (order.sessionId) {
          const session = await stripeClient().checkout.sessions.retrieve(order.sessionId);
          if (session.status === 'complete') {
            throw new ConflictError(
              'CHECKOUT_CONFIRMATION_PENDING',
              'Wait for the completed checkout to be confirmed',
            );
          }
          if (session.status === 'open') await stripeClient().checkout.sessions.expire(session.id);
        }
        await CheckoutOrder.updateOne({ _id: order._id }, { $set: { state: 'expired' } }).exec();
      }
      const now = new Date();
      await mongoose.connection.transaction(async () => {
        await Subscription.updateOne({ _id: sub._id }, { $inc: { seatVersion: 1 } }).exec();
        const used = await User.countDocuments({
          $or: [
            { status: 'active' },
            { status: 'invited', emailVerifyTokenExpiresAt: { $gt: now } },
          ],
        }).exec();
        if (used > PLANS.trial.seatLimit)
          throw new ConflictError(
            'SEAT_LIMIT_REACHED',
            'Reduce occupied seats to ten before restarting a trial',
            { used, limit: PLANS.trial.seatLimit },
          );
        await Subscription.updateOne(
          { _id: sub._id },
          {
            $set: {
              tier: 'trial',
              status: 'trialing',
              trialEndsAt: new Date(now.getTime() + TRIAL_MS),
              currentPeriodStart: now,
              currentPeriodEnd: new Date(now.getTime() + TRIAL_MS),
              seats: PLANS.trial.seatLimit,
              cancelAtPeriodEnd: false,
              scheduledTier: null,
              gateway: 'stripe',
              gatewaySubscriptionId: null,
              paymentMethod: null,
              lastTrialRestartedAt: now,
            },
            $inc: { trialRestartCount: 1 },
          },
        ).exec();
        await Factory.updateOne(
          { _id: ctx.tenantId, status: { $ne: 'suspended' } },
          { $set: { status: 'trial' } },
        ).exec();
      });
      return view(await ensureSubscription(ctx.tenantId));
    });
  }

  async createCheckoutSession(ctx: TenantContext, input: CreateCheckoutSessionRequest) {
    await verifiedOwner(ctx);
    returnUrl(input.successUrl);
    returnUrl(input.cancelUrl);
    return billingLock(ctx.tenantId, async () => {
      if (input.tier === 'trial')
        throw new BadRequestError('INVALID_TIER', 'Trial cannot be purchased');
      const tier = input.tier as SubscriptionTier,
        plan = PLANS[tier];
      const sub = await ensureSubscription(ctx.tenantId);
      for (const pending of await CheckoutOrder.find({
        state: 'pending',
        sessionId: { $type: 'string' },
      })
        .lean()
        .exec()) {
        const previous = await stripeClient().checkout.sessions.retrieve(pending.sessionId!);
        if (previous.status === 'complete')
          throw new ConflictError(
            'CHECKOUT_CONFIRMATION_PENDING',
            'Existing checkout is awaiting payment confirmation',
          );
        if (previous.status === 'open') await stripeClient().checkout.sessions.expire(previous.id);
        await CheckoutOrder.updateOne({ _id: pending._id }, { $set: { state: 'expired' } }).exec();
      }
      if (sub.gateway === 'stripe' && sub.gatewaySubscriptionId?.startsWith('sub_')) {
        const remote = await stripeClient().subscriptions.retrieve(sub.gatewaySubscriptionId);
        if (!['canceled', 'incomplete_expired'].includes(remote.status))
          throw new ConflictError(
            'SUBSCRIPTION_EXISTS',
            'Use plan change or billing portal for your existing Stripe subscription',
          );
      }
      const user = await authRepository.findUserById(ctx.userId);
      if (!user) throw new NotFoundError();
      let customer =
        sub.gateway === 'stripe' && sub.gatewayCustomerId?.startsWith('cus_')
          ? sub.gatewayCustomerId
          : null;
      if (!customer) {
        const created = await stripeClient().customers.create(
          {
            email: user.email,
            name: user.fullName,
            metadata: { tenantId: ctx.tenantId.toString(), application: 'scp-platform' },
          },
          { idempotencyKey: `scp-customer-${ctx.tenantId}` },
        );
        customer = created.id;
        await billingRepository.upsertSubscription(ctx.tenantId, {
          gateway: 'stripe',
          gatewayCustomerId: customer,
        });
      }
      const price = await stripePrice(tier);
      // Immutable order binds the paid session to one server-defined tier and amount.
      const order = await mongoose.connection.transaction(async () => {
        await Subscription.updateOne({ _id: sub._id }, { $inc: { seatVersion: 1 } }).exec();
        const used = await User.countDocuments({
          $or: [
            { status: 'active' },
            { status: 'invited', emailVerifyTokenExpiresAt: { $gt: new Date() } },
          ],
        }).exec();
        if (used > plan.seatLimit)
          throw new ConflictError(
            'SEAT_LIMIT_REACHED',
            'Reduce occupied seats before choosing this plan',
            { used, limit: plan.seatLimit },
          );
        return CheckoutOrder.create({
          tier,
          amount: plan.monthlyPrice.amount * 100,
          currency: 'usd',
        });
      });
      const metadata = {
        tenantId: ctx.tenantId.toString(),
        orderId: order._id.toString(),
        tier,
        application: 'scp-platform',
      };
      const session = await stripeClient().checkout.sessions.create(
        {
          mode: 'subscription',
          customer,
          client_reference_id: ctx.tenantId.toString(),
          metadata,
          subscription_data: { metadata },
          line_items: [{ price: price.id, quantity: 1 }],
          success_url: returnUrl(input.successUrl),
          cancel_url: returnUrl(input.cancelUrl),
          allowed_payment_method_types: ['card'],
        },
        { idempotencyKey: `scp-checkout-${order._id}` },
      );
      await CheckoutOrder.updateOne({ _id: order._id }, { $set: { sessionId: session.id } }).exec();
      return { redirectUrl: session.url, sessionId: session.id, orderId: order._id.toString() };
    });
  }

  async createPortalSession(ctx: TenantContext, input: { returnUrl: string }) {
    await verifiedOwner(ctx);
    const sub = await ensureSubscription(ctx.tenantId);
    if (sub.gateway !== 'stripe' || !sub.gatewayCustomerId?.startsWith('cus_'))
      throw new BadRequestError('STRIPE_CUSTOMER_MISSING', 'Start Stripe checkout first');
    const api = stripeClient();
    const configs = await api.billingPortal.configurations.list({ active: true, limit: 100 });
    let config = configs.data.find((row) => row.metadata?.application === 'scp-platform');
    if (!config)
      config = await api.billingPortal.configurations.create({
        metadata: { application: 'scp-platform' },
        business_profile: { headline: 'Manage your Supply Chain subscription' },
        features: {
          invoice_history: { enabled: true },
          payment_method_update: { enabled: true },
          subscription_cancel: { enabled: true, mode: 'at_period_end' },
        },
      });
    const session = await api.billingPortal.sessions.create({
      customer: sub.gatewayCustomerId,
      configuration: config.id,
      return_url: returnUrl(input.returnUrl),
    });
    return { redirectUrl: session.url };
  }

  async changeSubscription(ctx: TenantContext, input: ChangeSubscriptionRequest) {
    await verifiedOwner(ctx);
    if (input.tier === 'trial')
      throw new BadRequestError('INVALID_TIER', 'Cannot switch back to a free trial');
    return billingLock(ctx.tenantId, async () => {
      const sub = await ensureSubscription(ctx.tenantId);
      if (sub.gateway !== 'stripe' || !sub.gatewaySubscriptionId?.startsWith('sub_'))
        throw new BadRequestError(
          'STRIPE_SUBSCRIPTION_MISSING',
          'Purchase a Stripe subscription first',
        );
      const api = stripeClient(),
        remote = await api.subscriptions.retrieve(sub.gatewaySubscriptionId);
      if (remote.status !== 'active')
        throw new ConflictError(
          'SUBSCRIPTION_NOT_ACTIVE',
          'Resolve the current subscription payment before changing plans',
        );
      const tier = input.tier as SubscriptionTier;
      await mongoose.connection.transaction(async () => {
        await Subscription.updateOne({ _id: sub._id }, { $inc: { seatVersion: 1 } }).exec();
        const used = await User.countDocuments({
          $or: [
            { status: 'active' },
            { status: 'invited', emailVerifyTokenExpiresAt: { $gt: new Date() } },
          ],
        }).exec();
        if (used > PLANS[tier].seatLimit)
          throw new ConflictError(
            'SEAT_LIMIT_REACHED',
            'Reduce occupied seats before downgrading',
            { used, limit: PLANS[tier].seatLimit },
          );
        await Subscription.updateOne({ _id: sub._id }, { $set: { scheduledTier: tier } }).exec();
      });
      const item = remote.items.data[0];
      if (!item)
        throw new BadRequestError('STRIPE_SUBSCRIPTION_INVALID', 'Subscription has no item');
      if (remote.schedule) await api.subscriptionSchedules.release(idOf(remote.schedule)!);
      const price = await stripePrice(tier);
      if (PLANS[tier].monthlyPrice.amount > PLANS[sub.tier].monthlyPrice.amount) {
        await api.subscriptions.update(remote.id, {
          items: [{ id: item.id, price: price.id }],
          proration_behavior: 'always_invoice',
          payment_behavior: 'pending_if_incomplete',
        });
      } else if (tier !== sub.tier) {
        const schedule = await api.subscriptionSchedules.create({ from_subscription: remote.id });
        await api.subscriptionSchedules.update(schedule.id, {
          end_behavior: 'release',
          phases: [
            {
              start_date: item.current_period_start,
              end_date: item.current_period_end,
              items: [{ price: item.price.id, quantity: 1 }],
              proration_behavior: 'none',
            },
            {
              items: [{ price: price.id, quantity: 1 }],
              duration: { interval: 'month', interval_count: 1 },
              proration_behavior: 'none',
              metadata: { tenantId: ctx.tenantId.toString(), tier },
            },
          ],
        });
      }
      await this.syncSubscription(remote.id, ctx.tenantId);
      return view(await ensureSubscription(ctx.tenantId));
    });
  }

  async cancelSubscription(ctx: TenantContext, input: CancelSubscriptionRequest) {
    await verifiedOwner(ctx);
    return billingLock(ctx.tenantId, async () => {
      const sub = await ensureSubscription(ctx.tenantId);
      if (sub.gateway === 'stripe' && sub.gatewaySubscriptionId?.startsWith('sub_')) {
        const api = stripeClient(),
          remote = await api.subscriptions.retrieve(sub.gatewaySubscriptionId);
        if (remote.schedule) await api.subscriptionSchedules.release(idOf(remote.schedule)!);
        if (input.cancelImmediately) await api.subscriptions.cancel(remote.id);
        else await api.subscriptions.update(remote.id, { cancel_at_period_end: true });
        await this.syncSubscription(remote.id, ctx.tenantId);
      } else {
        await billingRepository.upsertSubscription(ctx.tenantId, {
          cancelAtPeriodEnd: !input.cancelImmediately,
          ...(input.cancelImmediately ? { status: 'cancelled' } : {}),
        });
      }
      return view(await ensureSubscription(ctx.tenantId));
    });
  }

  async listInvoices(_ctx: TenantContext, query: ListInvoicesQuery) {
    const page = await billingRepository.listInvoices(query);
    return {
      ...page,
      rows: page.rows.map((i) => ({
        id: i._id.toString(),
        number: i.number,
        amountSubtotal: i.amountSubtotal,
        amountTax: i.amountTax,
        amountTotal: i.amountTotal,
        currency: i.currency,
        status: i.status,
        pdfUrl: i.pdfUrl,
        issuedAt: i.issuedAt,
        paidAt: i.paidAt,
        dueAt: i.dueAt,
      })),
    };
  }

  async ingestWebhook(args: { gateway: 'stripe'; rawBody: Buffer; signature: string | null }) {
    if (!env.STRIPE_WEBHOOK_SECRET || !args.signature)
      throw new UnauthorizedError(
        'STRIPE_SIGNATURE_REQUIRED',
        'Stripe webhook signature/configuration missing',
      );
    let event: Stripe.Event;
    try {
      event = stripeClient().webhooks.constructEvent(
        args.rawBody,
        args.signature,
        env.STRIPE_WEBHOOK_SECRET,
      );
    } catch {
      throw new UnauthorizedError(
        'STRIPE_SIGNATURE_INVALID',
        'Invalid or stale Stripe webhook signature',
      );
    }
    if (await StripeEventReceipt.exists({ _id: event.id }))
      return { accepted: true, duplicate: true };
    const object = event.data.object as unknown as {
      id: string;
      metadata?: Record<string, string>;
      subscription?: string;
      parent?: { subscription_details?: { subscription?: string } };
    };
    if (event.type === 'checkout.session.expired') {
      const session = await stripeClient().checkout.sessions.retrieve(object.id);
      const rawTenant = session.metadata?.tenantId;
      if (!rawTenant || !Types.ObjectId.isValid(rawTenant) || session.status !== 'expired')
        return { accepted: true, ignored: true };
      const tenantId = new Types.ObjectId(rawTenant);
      return tenantStorage.run({ tenantId }, () =>
        billingLock(tenantId, async () => {
          if (await StripeEventReceipt.exists({ _id: event.id }))
            return { accepted: true, duplicate: true };
          await CheckoutOrder.updateOne(
            { sessionId: session.id, state: 'pending' },
            { $set: { state: 'expired' } },
          ).exec();
          await StripeEventReceipt.create({
            _id: event.id,
            type: event.type,
            tenantId,
            processedAt: new Date(),
          });
          return { accepted: true };
        }),
      );
    }
    let remoteId: string | null = null;
    if (event.type.startsWith('checkout.session.'))
      remoteId = idOf((event.data.object as Stripe.Checkout.Session).subscription);
    else if (event.type.startsWith('customer.subscription.')) remoteId = object.id;
    else if (event.type.startsWith('invoice.'))
      remoteId = idOf(object.parent?.subscription_details?.subscription ?? object.subscription);
    if (!remoteId) return { accepted: true, ignored: true };
    const remote = await stripeClient().subscriptions.retrieve(remoteId);
    const rawTenant = remote.metadata.tenantId;
    if (!rawTenant || !Types.ObjectId.isValid(rawTenant)) return { accepted: true, ignored: true };
    const tenantId = new Types.ObjectId(rawTenant);
    return tenantStorage.run({ tenantId }, () =>
      billingLock(tenantId, async () => {
        if (await StripeEventReceipt.exists({ _id: event.id }))
          return { accepted: true, duplicate: true };
        // Fetch current Stripe state inside the tenant lock: old events cannot restore old access.
        if (event.type.startsWith('checkout.session.')) {
          const session = await stripeClient().checkout.sessions.retrieve(object.id);
          const order = await CheckoutOrder.findOne({ sessionId: session.id }).lean().exec();
          if (
            !order ||
            session.customer !== idOf(remote.customer) ||
            session.metadata?.orderId !== order._id.toString() ||
            session.currency !== order.currency ||
            session.amount_total !== order.amount
          )
            throw new BadRequestError(
              'STRIPE_ORDER_MISMATCH',
              'Checkout does not match its immutable order',
            );
        }
        await this.syncSubscription(
          remoteId,
          tenantId,
          event.type.startsWith('invoice.') ? object.id : undefined,
        );
        await StripeEventReceipt.create({
          _id: event.id,
          type: event.type,
          tenantId,
          processedAt: new Date(),
        });
        return { accepted: true };
      }),
    );
  }

  async syncSubscription(
    remoteId: string,
    tenantId: Types.ObjectId,
    eventInvoiceId?: string,
  ): Promise<void> {
    const api = stripeClient();
    const remote = await api.subscriptions.retrieve(remoteId);
    if (remote.metadata.tenantId !== tenantId.toString())
      throw new BadRequestError('STRIPE_TENANT_MISMATCH', 'Subscription tenant mismatch');
    const local = await ensureSubscription(tenantId);
    const item = remote.items.data[0];
    if (!item || remote.items.data.length !== 1 || item.quantity !== 1)
      throw new BadRequestError(
        'STRIPE_SUBSCRIPTION_INVALID',
        'Expected one monthly subscription item',
      );
    const price = await api.prices.retrieve(item.price.id),
      tier = tierForPrice(price);
    const customer = idOf(remote.customer);
    if (customer !== local.gatewayCustomerId)
      throw new BadRequestError('STRIPE_CUSTOMER_MISMATCH', 'Subscription customer mismatch');
    const invoiceId = idOf(remote.latest_invoice);
    const invoice = invoiceId ? await api.invoices.retrieve(invoiceId) : null;
    const paid =
      invoice?.status === 'paid' && invoice.amount_remaining === 0 && invoice.currency === 'usd';
    const matching = local.gatewaySubscriptionId === remoteId;
    if (!matching) {
      // A delayed event for a terminated paid subscription must not touch a restarted trial.
      if (remote.status === 'canceled' || remote.status === 'incomplete_expired') return;
      if (
        local.gateway === 'stripe' &&
        local.gatewaySubscriptionId?.startsWith('sub_') &&
        subscriptionAccess(local) === 'full'
      )
        return;
      const order = remote.metadata.orderId
        ? await CheckoutOrder.findById(remote.metadata.orderId).lean().exec()
        : null;
      if (
        !order ||
        order.tier !== tier ||
        order.amount !== price.unit_amount ||
        order.currency !== price.currency
      )
        throw new BadRequestError(
          'STRIPE_ORDER_MISMATCH',
          'Subscription does not match its checkout order',
        );
      if (!paid || remote.status !== 'active') return; // Starting checkout never removes a still-valid local trial.
    }
    const affected =
      eventInvoiceId && eventInvoiceId !== invoiceId
        ? await api.invoices.retrieve(eventInvoiceId)
        : invoice;
    await mongoose.connection.transaction(async () => {
      const current = await Subscription.findOneAndUpdate(
        { tenantId },
        { $inc: { seatVersion: 1 } },
        { new: true },
      )
        .lean()
        .exec();
      if (!current) throw new NotFoundError();
      // A terminal Stripe subscription must never regain access from a delayed payment event.
      const terminal =
        remote.status === 'canceled' ||
        remote.status === 'incomplete_expired' ||
        (matching && current.status === 'cancelled');
      const pendingUpgrade =
        matching &&
        !!remote.pending_update &&
        current.status === 'active' &&
        current.currentPeriodEnd > new Date();
      const status = terminal
        ? 'cancelled'
        : remote.status === 'active' && (paid || pendingUpgrade)
          ? 'active'
          : 'past_due';
      const grantedTier = status === 'active' ? tier : current.tier;
      await billingRepository.upsertSubscription(tenantId, {
        gateway: 'stripe',
        gatewayCustomerId: customer,
        gatewaySubscriptionId: remoteId,
        status,
        tier: grantedTier,
        seats: PLANS[grantedTier].seatLimit,
        currentPeriodStart: new Date(item.current_period_start * 1000),
        currentPeriodEnd: new Date(item.current_period_end * 1000),
        cancelAtPeriodEnd: remote.cancel_at_period_end || !!remote.cancel_at,
        ...(status === 'active' && current.scheduledTier === tier ? { scheduledTier: null } : {}),
      });
      if (status === 'active')
        await Factory.updateOne(
          { _id: tenantId, status: { $ne: 'suspended' } },
          { $set: { status: 'active' } },
        ).exec();
      if (remote.metadata.orderId && status === 'active')
        await CheckoutOrder.updateOne(
          { _id: remote.metadata.orderId },
          { $set: { state: 'paid', subscriptionId: remoteId } },
        ).exec();
      if (affected && idOf(affected.customer) === customer) {
        const invoiceSub = idOf(affected.parent?.subscription_details?.subscription);
        if (invoiceSub !== remoteId)
          throw new BadRequestError('STRIPE_INVOICE_MISMATCH', 'Invoice subscription mismatch');
        const invoicePaid = affected.status === 'paid';
        const saved = await billingRepository.upsertInvoiceByGatewayId(tenantId, affected.id, {
          subscriptionId: current._id,
          number: affected.number ?? `STR-${affected.id.slice(-24)}`,
          amountSubtotal: affected.subtotal,
          amountTax: Math.max(0, affected.total - affected.subtotal),
          amountTotal: affected.total,
          currency: 'USD',
          status: invoicePaid
            ? 'paid'
            : affected.status === 'void'
              ? 'void'
              : affected.status === 'uncollectible'
                ? 'failed'
                : 'open',
          gateway: 'stripe',
          pdfUrl: affected.invoice_pdf,
          issuedAt: new Date(affected.created * 1000),
          paidAt: invoicePaid
            ? new Date((affected.status_transitions.paid_at ?? affected.created) * 1000)
            : null,
          dueAt: affected.due_date ? new Date(affected.due_date * 1000) : null,
        });
        await billingRepository.upsertPaymentAttemptByGatewayId(tenantId, affected.id, {
          invoiceId: saved!._id,
          subscriptionId: current._id,
          amount: affected.total,
          currency: 'USD',
          gateway: 'stripe',
          status: invoicePaid ? 'succeeded' : affected.attempt_count > 0 ? 'failed' : 'pending',
          resolvedAt: invoicePaid || affected.attempt_count > 0 ? new Date() : null,
          errorCode: invoicePaid || affected.attempt_count === 0 ? null : 'PAYMENT_FAILED',
        });
      }
    });
  }
}
export const billingService = new BillingService();
