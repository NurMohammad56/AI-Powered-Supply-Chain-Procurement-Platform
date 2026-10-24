import type { Types } from 'mongoose';
import { tenantStorage } from '../../shared/db/tenancyPlugin.js';
import type { TenantContext, Role } from '../../shared/auth/types.js';
import {
  ForbiddenError,
  UnauthorizedError,
  ConflictError,
} from '../../shared/errors/HttpErrors.js';
import { User } from '../auth/models/user.model.js';
import { Factory } from '../auth/models/factory.model.js';
import { Subscription, type SubscriptionDoc } from './models/subscription.model.js';
import { PLANS, TRIAL_MS, type Feature } from './plans.js';
import { CheckoutOrder } from './models/checkoutOrder.model.js';
export type AccessMode = 'full' | 'read_only' | 'verification_required' | 'suspended';
export function subscriptionAccess(sub: SubscriptionDoc, now = new Date()): 'full' | 'read_only' {
  if (sub.status === 'trialing' && sub.tier === 'trial' && sub.trialEndsAt && sub.trialEndsAt > now)
    return 'full';
  if (sub.tier !== 'trial' && sub.status === 'active' && sub.currentPeriodEnd > now) return 'full';
  return 'read_only';
}
export async function ensureSubscription(tenantId: Types.ObjectId): Promise<SubscriptionDoc> {
  const current = await Subscription.findOne({ tenantId }).lean().exec();
  if (current) return current;
  const factory = await Factory.findById(tenantId).lean().exec();
  if (!factory) throw new UnauthorizedError('AUTH_TENANT_NOT_FOUND', 'Company not found');
  const end = new Date(factory.createdAt.getTime() + TRIAL_MS);
  const sub = await Subscription.findOneAndUpdate(
    { tenantId },
    {
      $setOnInsert: {
        tier: 'trial',
        status: 'trialing',
        trialEndsAt: end,
        currentPeriodStart: factory.createdAt,
        currentPeriodEnd: end,
        gateway: 'stripe',
        seats: PLANS.trial.seatLimit,
      },
    },
    { upsert: true, new: true, runValidators: true },
  )
    .lean()
    .exec();
  if (!sub) throw new Error('Could not provision subscription');
  return sub;
}
/** DB authority is re-read for requests/jobs; JWT tier and role cannot grant stale access. */
export async function resolveAccount(
  ctx: TenantContext,
): Promise<TenantContext & { accessMode: AccessMode; emailVerified: boolean }> {
  return tenantStorage.run({ tenantId: ctx.tenantId }, async () => {
    const [user, factory, sub] = await Promise.all([
      User.findById(ctx.userId).lean().exec(),
      Factory.findById(ctx.tenantId).lean().exec(),
      ensureSubscription(ctx.tenantId),
    ]);
    if (!user || user.status !== 'active' || !factory)
      throw new UnauthorizedError('AUTH_ACCOUNT_DISABLED', 'Account unavailable');
    const verified = !!user.emailVerifiedAt;
    const accessMode: AccessMode =
      factory.status === 'suspended'
        ? 'suspended'
        : !verified
          ? 'verification_required'
          : factory.status === 'cancelled'
            ? 'read_only'
            : subscriptionAccess(sub);
    return {
      ...ctx,
      role: user.role,
      subscriptionTier: sub.tier,
      seats: PLANS[sub.tier].seatLimit,
      features: new Set(PLANS[sub.tier].features),
      emailVerified: verified,
      accessMode,
    };
  });
}
export async function requireFeature(
  ctx: TenantContext,
  feature: Feature,
  roles?: Role[],
): Promise<TenantContext> {
  const account = await resolveAccount(ctx);
  if (!account.emailVerified)
    throw new ForbiddenError('EMAIL_VERIFICATION_REQUIRED', 'Verify your email to continue');
  if (account.accessMode !== 'full')
    throw new ForbiddenError('SUBSCRIPTION_READ_ONLY', 'Subscription allows read/export only');
  if (!account.features.has(feature))
    throw new ForbiddenError('PLAN_FEATURE_UNAVAILABLE', `Your plan does not include ${feature}`, {
      feature,
    });
  if (roles && !roles.includes(account.role))
    throw new ForbiddenError('RBAC_CAPABILITY_DENIED', 'Your role cannot perform this action');
  return account;
}
export async function requireTenantFeature(
  tenantId: Types.ObjectId,
  feature: Feature,
): Promise<void> {
  const [sub, company] = await Promise.all([
    ensureSubscription(tenantId),
    Factory.findById(tenantId).lean().exec(),
  ]);
  if (
    !company ||
    company.status === 'suspended' ||
    company.status === 'cancelled' ||
    subscriptionAccess(sub) !== 'full'
  )
    throw new ForbiddenError('SUBSCRIPTION_READ_ONLY', 'Company subscription is not active');
  if (!PLANS[sub.tier].features.includes(feature))
    throw new ForbiddenError('PLAN_FEATURE_UNAVAILABLE', `Plan does not include ${feature}`);
}
/** Transactional write serializes competing invites, followed by an authoritative seat count. */
export async function reserveSeat(
  tenantId: Types.ObjectId,
  excludeUserId?: Types.ObjectId,
): Promise<void> {
  await ensureSubscription(tenantId);
  const sub = await Subscription.findOneAndUpdate(
    { tenantId },
    { $inc: { seatVersion: 1 } },
    { new: true },
  )
    .lean()
    .exec();
  if (!sub) throw new Error('Subscription unavailable');
  const used = await User.countDocuments({
    ...(excludeUserId ? { _id: { $ne: excludeUserId } } : {}),
    $or: [
      { status: 'active' },
      { status: 'invited', emailVerifyTokenExpiresAt: { $gt: new Date() } },
    ],
  }).exec();
  const limit = await effectiveSeatLimit(sub);
  if (used >= limit)
    throw new ConflictError('SEAT_LIMIT_REACHED', 'No available seats; disable a user or upgrade', {
      used,
      limit,
    });
}
export async function effectiveSeatLimit(sub: SubscriptionDoc): Promise<number> {
  // Abandoned Checkout cannot reserve a lower seat cap beyond its default 24h lifetime.
  const pending = await CheckoutOrder.find({
    state: 'pending',
    createdAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  })
    .lean()
    .exec();
  return Math.min(
    PLANS[sub.tier].seatLimit,
    sub.scheduledTier ? PLANS[sub.scheduledTier].seatLimit : Infinity,
    ...pending.map((order) => PLANS[order.tier].seatLimit),
  );
}
