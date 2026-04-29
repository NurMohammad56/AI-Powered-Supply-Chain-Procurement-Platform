import type { Request } from 'express';

import { asyncHandler } from '../../shared/http/asyncHandler.js';
import { ok, paginated } from '../../shared/http/apiResponse.js';
import { UnauthorizedError } from '../../shared/errors/HttpErrors.js';
import { ErrorCodes } from '../../shared/errors/errorCodes.js';
import type { TenantContext } from '../../shared/auth/types.js';
import { billingService } from './billing.service.js';

function requireContext(req: Request): TenantContext {
  if (!req.context) {
    throw new UnauthorizedError(ErrorCodes.AUTH_TOKEN_MISSING, 'Tenant context not resolved');
  }
  return req.context;
}

export const billingController = {
  listPlans: asyncHandler(async (req, res) => {
    const result = billingService.listPlans();
    return ok(req, res, result);
  }),
  getSubscription: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await billingService.getSubscription(ctx);
    return ok(req, res, result);
  }),
  createCheckoutSession: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await billingService.createCheckoutSession(ctx, req.body);
    return ok(req, res, result);
  }),
  changeSubscription: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await billingService.changeSubscription(ctx, req.body);
    return ok(req, res, result);
  }),
  cancelSubscription: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await billingService.cancelSubscription(ctx, req.body);
    return ok(req, res, result);
  }),
  listInvoices: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await billingService.listInvoices(ctx, req.query as never);
    return paginated(req, res, result.rows, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      limit: result.limit,
    });
  }),
  webhookStripe: asyncHandler(async (req, res) => {
    const sig = (req.headers['stripe-signature'] as string | undefined) ?? null;
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    const result = await billingService.ingestWebhook({
      gateway: 'stripe',
      rawBody: raw,
      signature: sig,
    });
    return ok(req, res, result);
  }),
  webhookSslCommerz: asyncHandler(async (req, res) => {
    const sig = (req.headers['x-sslcommerz-signature'] as string | undefined) ?? null;
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    const result = await billingService.ingestWebhook({
      gateway: 'sslcommerz',
      rawBody: raw,
      signature: sig,
    });
    return ok(req, res, result);
  }),
};
