import { Types } from 'mongoose';
import type { RequestHandler } from 'express';

import { UnauthorizedError } from '../errors/HttpErrors.js';
import { ErrorCodes } from '../errors/errorCodes.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { tenantStorage } from '../db/tenancyPlugin.js';
import type { TenantContext } from '../auth/types.js';

/**
 * Control Point 1 of the multi-tenant boundary (SDD §2.4.1).
 *
 * Verifies the JWT and constructs `req.context`. The tenant context is
 * derived **only** from JWT claims - never from headers, query strings,
 * route params, or request bodies. Endpoints that legitimately operate
 * without a tenant are mounted on a separate router that does not include
 * this middleware.
 */
export const resolveTenant: RequestHandler = (req, _res, next) => {
  const auth = req.header('authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return next(new UnauthorizedError(ErrorCodes.AUTH_TOKEN_MISSING, 'Authorization header missing'));
  }
  const token = auth.slice('Bearer '.length).trim();
  if (!token) {
    return next(new UnauthorizedError(ErrorCodes.AUTH_TOKEN_MISSING, 'Bearer token empty'));
  }
  const claims = verifyAccessToken(token);

  const ctx: TenantContext = {
    factoryId: new Types.ObjectId(claims.factoryId),
    userId: new Types.ObjectId(claims.sub),
    role: claims.role,
    subscriptionTier: claims.tier,
    seats: claims.seats,
    features: new Set(claims.features ?? []),
    requestId: req.id ?? '',
  };

  req.context = ctx;
  next();
};

/**
 * Wraps the rest of the request lifecycle in a tenant-scoped
 * AsyncLocalStorage so every Mongoose call observes the current tenant.
 * Must run AFTER `resolveTenant`.
 */
export const tenantScope: RequestHandler = (req, _res, next) => {
  const ctx = req.context;
  if (!ctx) {
    return next(new UnauthorizedError(ErrorCodes.AUTH_TOKEN_MISSING, 'Tenant context not resolved'));
  }
  tenantStorage.run({ factoryId: ctx.factoryId }, () => next());
};
