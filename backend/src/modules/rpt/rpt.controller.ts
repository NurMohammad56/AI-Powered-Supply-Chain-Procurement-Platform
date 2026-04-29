import type { Request } from 'express';

import { asyncHandler } from '../../shared/http/asyncHandler.js';
import { ok } from '../../shared/http/apiResponse.js';
import { UnauthorizedError } from '../../shared/errors/HttpErrors.js';
import { ErrorCodes } from '../../shared/errors/errorCodes.js';
import type { TenantContext } from '../../shared/auth/types.js';
import { rptService } from './rpt.service.js';

function requireContext(req: Request): TenantContext {
  if (!req.context) {
    throw new UnauthorizedError(ErrorCodes.AUTH_TOKEN_MISSING, 'Tenant context not resolved');
  }
  return req.context;
}

export const rptController = {
  inventoryTurnover: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await rptService.inventoryTurnover(ctx, req.query as never);
    return ok(req, res, result);
  }),
  spendBySupplier: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await rptService.spendBySupplier(ctx, req.query as never);
    return ok(req, res, result);
  }),
  supplierCostComparison: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await rptService.supplierCostComparison(ctx, req.query as never);
    return ok(req, res, result);
  }),
  cashFlowProjection: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await rptService.cashFlowProjection(ctx);
    return ok(req, res, result);
  }),
  deadStock: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await rptService.deadStock(ctx, req.query as never);
    return ok(req, res, result);
  }),
};
