import type { Request } from 'express';
import { Types } from 'mongoose';

import { asyncHandler } from '../../shared/http/asyncHandler.js';
import { ok, created, noContent, paginated } from '../../shared/http/apiResponse.js';
import { UnauthorizedError } from '../../shared/errors/HttpErrors.js';
import { ErrorCodes } from '../../shared/errors/errorCodes.js';
import type { TenantContext } from '../../shared/auth/types.js';
import { supplierService } from './supplier.service.js';

function requireContext(req: Request): TenantContext {
  if (!req.context) {
    throw new UnauthorizedError(ErrorCodes.AUTH_TOKEN_MISSING, 'Tenant context not resolved');
  }
  return req.context;
}

function objId(raw: string): Types.ObjectId {
  return new Types.ObjectId(raw);
}

export const supplierController = {
  create: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await supplierService.create(ctx, req.body);
    return created(req, res, result);
  }),
  get: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await supplierService.get(ctx, objId(req.params.id ?? ''));
    return ok(req, res, result);
  }),
  update: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await supplierService.update(ctx, objId(req.params.id ?? ''), req.body);
    return ok(req, res, result);
  }),
  archive: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    await supplierService.archive(ctx, objId(req.params.id ?? ''));
    return noContent(res);
  }),
  list: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await supplierService.list(ctx, req.query as never);
    return paginated(req, res, result.rows, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      limit: result.limit,
    });
  }),
  addContact: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await supplierService.addContact(ctx, objId(req.params.id ?? ''), req.body);
    return created(req, res, result);
  }),
  updateContact: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const idx = Number(req.params.contactIndex);
    const result = await supplierService.updateContact(
      ctx,
      objId(req.params.id ?? ''),
      idx,
      req.body,
    );
    return ok(req, res, result);
  }),
  removeContact: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const idx = Number(req.params.contactIndex);
    const result = await supplierService.removeContact(ctx, objId(req.params.id ?? ''), idx);
    return ok(req, res, result);
  }),
  addDocument: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await supplierService.addDocument(ctx, objId(req.params.id ?? ''), req.body);
    return created(req, res, result);
  }),
  removeDocument: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const idx = Number(req.params.documentIndex);
    const result = await supplierService.removeDocument(ctx, objId(req.params.id ?? ''), idx);
    return ok(req, res, result);
  }),
  getPerformance: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await supplierService.getPerformance(ctx, objId(req.params.id ?? ''));
    return ok(req, res, result);
  }),
  compare: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const ids = (req.query.ids as unknown as string[]) ?? [];
    const result = await supplierService.compare(ctx, ids);
    return ok(req, res, result);
  }),
};
