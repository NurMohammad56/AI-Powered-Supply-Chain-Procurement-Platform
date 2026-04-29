import type { Request } from 'express';
import { Types } from 'mongoose';

import { asyncHandler } from '../../shared/http/asyncHandler.js';
import { ok, created, paginated } from '../../shared/http/apiResponse.js';
import { UnauthorizedError } from '../../shared/errors/HttpErrors.js';
import { ErrorCodes } from '../../shared/errors/errorCodes.js';
import type { TenantContext } from '../../shared/auth/types.js';
import { poService } from './po.service.js';

function requireContext(req: Request): TenantContext {
  if (!req.context) {
    throw new UnauthorizedError(ErrorCodes.AUTH_TOKEN_MISSING, 'Tenant context not resolved');
  }
  return req.context;
}

function objId(raw: string): Types.ObjectId {
  return new Types.ObjectId(raw);
}

export const poController = {
  create: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await poService.create(ctx, req.body);
    return created(req, res, result);
  }),
  update: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await poService.update(ctx, objId(req.params.id ?? ''), req.body);
    return ok(req, res, result);
  }),
  get: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await poService.get(ctx, objId(req.params.id ?? ''));
    return ok(req, res, result);
  }),
  list: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await poService.list(ctx, req.query as never);
    return paginated(req, res, result.rows, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      limit: result.limit,
    });
  }),
  submit: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await poService.submit(ctx, objId(req.params.id ?? ''));
    return ok(req, res, result);
  }),
  approve: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await poService.approve(ctx, objId(req.params.id ?? ''), req.body);
    return ok(req, res, result);
  }),
  reject: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await poService.reject(ctx, objId(req.params.id ?? ''), req.body);
    return ok(req, res, result);
  }),
  dispatch: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await poService.dispatch(ctx, objId(req.params.id ?? ''), req.body);
    return ok(req, res, result);
  }),
  cancel: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await poService.cancel(ctx, objId(req.params.id ?? ''), req.body);
    return ok(req, res, result);
  }),
  receive: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await poService.receive(ctx, objId(req.params.id ?? ''), req.body);
    return created(req, res, result);
  }),
  listReceipts: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await poService.listReceipts(ctx, objId(req.params.id ?? ''));
    return ok(req, res, result);
  }),
  close: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await poService.close(ctx, objId(req.params.id ?? ''));
    return ok(req, res, result);
  }),
};
