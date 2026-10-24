import Stripe from 'stripe';
import { env } from '../../config/env.js';
import { BadRequestError, InternalError } from '../../shared/errors/HttpErrors.js';
import { PLANS } from './plans.js';
import type { SubscriptionTier } from '../../shared/auth/types.js';
let client: Stripe | undefined;
export function stripeClient(): Stripe {
  if (!env.STRIPE_SECRET_KEY)
    throw new InternalError('STRIPE_NOT_CONFIGURED', 'Stripe secret key is not configured');
  return (client ??= new Stripe(env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, timeout: 20_000 }));
}
const priceCache = new Map<string, Stripe.Price>();
export async function stripePrice(tier: SubscriptionTier): Promise<Stripe.Price> {
  if (tier === 'trial')
    throw new BadRequestError('INVALID_TIER', 'Trial is free and cannot be purchased');
  const cached = priceCache.get(tier);
  if (cached) return cached;
  const api = stripeClient();
  const amount = PLANS[tier].monthlyPrice.amount * 100;
  const lookup = `scp-${tier}-usd-${amount}-monthly-v1`;
  const found = await api.prices.list({ lookup_keys: [lookup], active: true, limit: 1 });
  let price = found.data[0];
  if (!price) {
    const product = await api.products.create(
      { name: `Supply Chain Platform - ${tier}`, metadata: { application: 'scp-platform', tier } },
      { idempotencyKey: `scp-product-${tier}-v1` },
    );
    price = await api.prices.create(
      {
        product: product.id,
        currency: 'usd',
        unit_amount: amount,
        recurring: { interval: 'month' },
        lookup_key: lookup,
        metadata: { application: 'scp-platform', tier },
      },
      { idempotencyKey: lookup },
    );
  }
  if (
    price.unit_amount !== amount ||
    price.currency !== 'usd' ||
    price.recurring?.interval !== 'month' ||
    price.recurring.interval_count !== 1 ||
    price.metadata.application !== 'scp-platform'
  )
    throw new InternalError('STRIPE_PRICE_MISMATCH', 'Stripe price does not match the server plan');
  priceCache.set(tier, price);
  return price;
}
export function tierForPrice(price: Stripe.Price): SubscriptionTier {
  const tier = price.metadata.tier as SubscriptionTier;
  if (
    !PLANS[tier] ||
    tier === 'trial' ||
    price.metadata.application !== 'scp-platform' ||
    price.currency !== 'usd' ||
    price.unit_amount !== PLANS[tier].monthlyPrice.amount * 100 ||
    price.recurring?.interval !== 'month' ||
    price.recurring.interval_count !== 1
  )
    throw new BadRequestError('STRIPE_PRICE_MISMATCH', 'Unsupported subscription price');
  return tier;
}
