import type { Request } from 'express';
import { Types } from 'mongoose';

import { asyncHandler } from '../../shared/http/asyncHandler.js';
import { ok, created, noContent, paginated } from '../../shared/http/apiResponse.js';
import { UnauthorizedError } from '../../shared/errors/HttpErrors.js';
import { ErrorCodes } from '../../shared/errors/errorCodes.js';
import type { TenantContext } from '../../shared/auth/types.js';
import { inventoryService } from './inventory.service.js';

function requireContext(req: Request): TenantContext {
  if (!req.context) {
    throw new UnauthorizedError(ErrorCodes.AUTH_TOKEN_MISSING, 'Tenant context not resolved');
  }
  return req.context;
}

function objId(raw: string): Types.ObjectId {
  return new Types.ObjectId(raw);
}

export const inventoryController = {
  // -------- Warehouses --------
  createWarehouse: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await inventoryService.createWarehouse(ctx, req.body);
    return created(req, res, result);
  }),
  getWarehouse: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await inventoryService.getWarehouse(ctx, objId(req.params.id));
    return ok(req, res, result);
  }),
  updateWarehouse: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await inventoryService.updateWarehouse(ctx, objId(req.params.id), req.body);
    return ok(req, res, result);
  }),
  deleteWarehouse: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    await inventoryService.archiveWarehouse(ctx, objId(req.params.id));
    return noContent(res);
  }),
  listWarehouses: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await inventoryService.listWarehouses(ctx, req.query as never);
    return paginated(req, res, result.rows, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      limit: result.limit,
    });
  }),

  // -------- Categories --------
  createCategory: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await inventoryService.createCategory(ctx, req.body);
    return created(req, res, result);
  }),
  getCategory: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await inventoryService.getCategory(ctx, objId(req.params.id));
    return ok(req, res, result);
  }),
  updateCategory: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await inventoryService.updateCategory(ctx, objId(req.params.id), req.body);
    return ok(req, res, result);
  }),
  deleteCategory: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    await inventoryService.archiveCategory(ctx, objId(req.params.id));
    return noContent(res);
  }),
  listCategories: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await inventoryService.listCategories(ctx, req.query as never);
    return paginated(req, res, result.rows, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      limit: result.limit,
    });
  }),

  // -------- Items --------
  createItem: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await inventoryService.createItem(ctx, req.body);
    return created(req, res, result);
  }),
  getItem: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await inventoryService.getItem(ctx, objId(req.params.id));
    return ok(req, res, result);
  }),
  updateItem: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await inventoryService.updateItem(ctx, objId(req.params.id), req.body);
    return ok(req, res, result);
  }),
  deleteItem: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    await inventoryService.archiveItem(ctx, objId(req.params.id));
    return noContent(res);
  }),
  listItems: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await inventoryService.listItems(ctx, req.query as never);
    return paginated(req, res, result.rows, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      limit: result.limit,
    });
  }),

  // -------- Stock movements --------
  adjustStock: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await inventoryService.adjustStock(ctx, objId(req.params.id), req.body);
    return ok(req, res, result);
  }),
  transferStock: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await inventoryService.transferStock(ctx, objId(req.params.id), req.body);
    return ok(req, res, result);
  }),
  getItemHistory: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await inventoryService.getItemHistory(ctx, objId(req.params.id), req.query as never);
    return paginated(req, res, result.rows, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      limit: result.limit,
    });
  }),
  getItemBalances: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await inventoryService.getItemBalances(ctx, objId(req.params.id));
    return ok(req, res, result);
  }),
  listLowStock: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await inventoryService.listLowStock(ctx, req.query as never);
    return paginated(req, res, result.rows, {
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
      limit: result.limit,
    });
  }),
  bulkImport: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await inventoryService.bulkImport(ctx, req.body);
    return ok(req, res, result);
  }),
};
