import type { RequestHandler } from 'express';

import { ForbiddenError, UnauthorizedError } from '../errors/HttpErrors.js';
import { ErrorCodes } from '../errors/errorCodes.js';
import { roleHasCapability } from '../auth/rbac.js';
import type { Capability } from '../auth/types.js';

/**
 * Capability-gated authorisation (SDD §3.3.2 / §9.3).
 *
 * Usage:
 *   router.post('/items', resolveTenant, tenantScope, rbacFor('inventory.item.create'), ...)
 */
export function rbacFor(capability: Capability): RequestHandler {
  return (req, _res, next) => {
    const ctx = req.context;
    if (!ctx) {
      return next(new UnauthorizedError(ErrorCodes.AUTH_TOKEN_MISSING));
    }
    if (!roleHasCapability(ctx.role, capability)) {
      return next(
        new ForbiddenError(ErrorCodes.RBAC_CAPABILITY_DENIED, `Capability denied: ${capability}`, {
          required: capability,
          role: ctx.role,
        }),
      );
    }
    next();
  };
}
