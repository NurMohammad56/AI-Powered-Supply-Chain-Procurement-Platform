import type { RequestHandler } from 'express';

import { PaymentRequiredError, UnauthorizedError } from '../errors/HttpErrors.js';
import { ErrorCodes } from '../errors/errorCodes.js';
import type { SubscriptionTier } from '../auth/types.js';

/**
 * Tier-gate middleware (SDD §3.3.2 step 4).
 *
 * Returns HTTP 402 with a structured `TIER_GATE` error if the caller's
 * active subscription tier does not include the required feature. The
 * full feature → tier matrix lives with the billing module (lands in a
 * later prompt); for now this middleware accepts a list of allowed tiers
 * directly so other modules can already gate features.
 */
export function tierGate(allowed: readonly SubscriptionTier[]): RequestHandler {
  const allowedSet = new Set(allowed);
  return (req, _res, next) => {
    const ctx = req.context;
    if (!ctx) {
      return next(new UnauthorizedError(ErrorCodes.AUTH_TOKEN_MISSING));
    }
    if (!allowedSet.has(ctx.subscriptionTier)) {
      return next(
        new PaymentRequiredError(ErrorCodes.TIER_GATE, 'Feature not available on current plan', {
          currentTier: ctx.subscriptionTier,
          allowedTiers: Array.from(allowedSet),
        }),
      );
    }
    next();
  };
}
