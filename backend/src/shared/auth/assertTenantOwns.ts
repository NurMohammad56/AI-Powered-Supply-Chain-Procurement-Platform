import type { Types } from 'mongoose';

import { logger } from '../../config/logger.js';
import { NotFoundError } from '../errors/HttpErrors.js';
import { ErrorCodes } from '../errors/errorCodes.js';
import type { TenantContext } from './types.js';

interface TenantOwnedResource {
  factoryId: Types.ObjectId;
}

/**
 * Control Point 3 of the multi-tenant boundary (SDD §2.4.3).
 *
 * Asserts that a fetched resource belongs to the caller's tenant. On
 * mismatch, throws `NotFoundError` (404) - **never** `ForbiddenError` (403).
 * Returning 403 leaks the existence of a resource in another tenant; 404
 * leaks nothing. The attempt is recorded to the audit/structured log for
 * forensic review regardless.
 */
export function assertTenantOwns<T extends TenantOwnedResource | null | undefined>(
  resource: T,
  ctx: TenantContext,
): asserts resource is NonNullable<T> {
  if (!resource) {
    throw new NotFoundError();
  }
  if (!resource.factoryId.equals(ctx.factoryId)) {
    logger.warn(
      {
        event: 'TENANCY_VIOLATION_BLOCKED',
        requestId: ctx.requestId,
        attemptedFactoryId: resource.factoryId.toString(),
        contextFactoryId: ctx.factoryId.toString(),
        userId: ctx.userId.toString(),
      },
      'Cross-tenant access attempt blocked',
    );
    throw new NotFoundError(ErrorCodes.NOT_FOUND);
  }
}
