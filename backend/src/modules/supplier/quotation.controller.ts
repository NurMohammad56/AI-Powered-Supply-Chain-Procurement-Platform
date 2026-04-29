import type { Request } from 'express';
import { Types } from 'mongoose';

import { asyncHandler } from '../../shared/http/asyncHandler.js';
import { ok, created, paginated } from '../../shared/http/apiResponse.js';
import { UnauthorizedError } from '../../shared/errors/HttpErrors.js';
import { ErrorCodes } from '../../shared/errors/errorCodes.js';
import type { TenantContext } from '../../shared/auth/types.js';
import { quotationService } from './quotation.service.js';

function requireContext(req: Request): TenantContext {
  if (!req.context) {
    throw new UnauthorizedError(ErrorCodes.AUTH_TOKEN_MISSING, 'Tenant context not resolved');
  }
  return req.context;
}

function objId(raw: string): Types.ObjectId {
  return new Types.ObjectId(raw);
}

export const quotationController = {
  create: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await quotationService.create(ctx, req.body);
    return created(req, res, result);
  }),
  list: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await quotationService.list(ctx, req.query as never);
    return paginated(req, res, result.rows, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      limit: result.limit,
    });
  }),
  get: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await quotationService.get(ctx, objId(req.params.id ?? ''));
    return ok(req, res, result);
  }),
  cancel: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await quotationService.cancel(ctx, objId(req.params.id ?? ''));
    return ok(req, res, result);
  }),
  accept: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await quotationService.accept(ctx, objId(req.params.id ?? ''), req.body);
    return ok(req, res, result);
  }),
  /**
   * Public token-gated endpoint - NOT tenant-scoped via JWT.
   * Tenant identity is derived from the quotation document.
   */
  submitResponse: asyncHandler(async (req, res) => {
    const result = await quotationService.submitResponse(req.params.token ?? '', req.body);
    return ok(req, res, result);
  }),
};
