import type { Request } from 'express';

import { asyncHandler } from '../../shared/http/asyncHandler.js';
import { ok, paginated } from '../../shared/http/apiResponse.js';
import { UnauthorizedError } from '../../shared/errors/HttpErrors.js';
import { ErrorCodes } from '../../shared/errors/errorCodes.js';
import type { TenantContext } from '../../shared/auth/types.js';
import { notificationService } from './notification.service.js';

function requireContext(req: Request): TenantContext {
  if (!req.context) {
    throw new UnauthorizedError(ErrorCodes.AUTH_TOKEN_MISSING, 'Tenant context not resolved');
  }
  return req.context;
}

export const notificationController = {
  list: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await notificationService.list(ctx, req.query as never);
    return paginated(req, res, result.rows, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      limit: result.limit,
    });
  }),
  unreadCount: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await notificationService.unreadCount(ctx);
    return ok(req, res, result);
  }),
  markRead: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await notificationService.markRead(ctx, req.body);
    return ok(req, res, result);
  }),
};
