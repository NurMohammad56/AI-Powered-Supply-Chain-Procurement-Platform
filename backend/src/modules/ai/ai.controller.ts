import type { Request } from 'express';
import { Types } from 'mongoose';

import { asyncHandler } from '../../shared/http/asyncHandler.js';
import { ok, paginated } from '../../shared/http/apiResponse.js';
import { UnauthorizedError } from '../../shared/errors/HttpErrors.js';
import { ErrorCodes } from '../../shared/errors/errorCodes.js';
import type { TenantContext } from '../../shared/auth/types.js';
import { aiService } from './ai.service.js';

function requireContext(req: Request): TenantContext {
  if (!req.context) {
    throw new UnauthorizedError(ErrorCodes.AUTH_TOKEN_MISSING, 'Tenant context not resolved');
  }
  return req.context;
}

function objId(raw: string): Types.ObjectId {
  return new Types.ObjectId(raw);
}

export const aiController = {
  generateForecast: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await aiService.generateForecast(ctx, req.body);
    return ok(req, res, result);
  }),
  getForecast: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await aiService.getForecast(ctx, objId(req.params.id ?? ''));
    return ok(req, res, result);
  }),
  listForecasts: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await aiService.listForecasts(ctx, req.query as never);
    return paginated(req, res, result.rows, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      limit: result.limit,
    });
  }),
  overrideForecast: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await aiService.overrideForecast(ctx, objId(req.params.id ?? ''), req.body);
    return ok(req, res, result);
  }),
};
