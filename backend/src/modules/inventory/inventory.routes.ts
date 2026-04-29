import { Router } from 'express';

import { validate } from '../../shared/middleware/validate.js';
import { rbacFor } from '../../shared/middleware/rbac.js';
import { idempotencyKey } from '../../shared/middleware/idempotency.js';
import {
  BulkImportRequestSchema,
  CategoryIdParamSchema,
  CreateItemCategoryRequestSchema,
  CreateItemRequestSchema,
  CreateWarehouseRequestSchema,
  ItemHistoryQuerySchema,
  ItemIdParamSchema,
  ListItemCategoriesQuerySchema,
  ListItemsQuerySchema,
  ListWarehousesQuerySchema,
  LowStockQuerySchema,
  StockAdjustmentRequestSchema,
  StockTransferRequestSchema,
  UpdateItemCategoryRequestSchema,
  UpdateItemRequestSchema,
  UpdateWarehouseRequestSchema,
  WarehouseIdParamSchema,
} from './inventory.dto.js';
import { inventoryController } from './inventory.controller.js';

export const inventoryRouter = Router();

// -------- Warehouses --------
inventoryRouter.get(
  '/warehouses',
  rbacFor('inventory.item.read'),
  validate(ListWarehousesQuerySchema, 'query'),
  inventoryController.listWarehouses,
);
inventoryRouter.post(
  '/warehouses',
  rbacFor('inventory.warehouse.manage'),
  idempotencyKey,
  validate(CreateWarehouseRequestSchema),
  inventoryController.createWarehouse,
);
inventoryRouter.get(
  '/warehouses/:id',
  rbacFor('inventory.item.read'),
  validate(WarehouseIdParamSchema, 'params'),
  inventoryController.getWarehouse,
);
inventoryRouter.patch(
  '/warehouses/:id',
  rbacFor('inventory.warehouse.manage'),
  validate(WarehouseIdParamSchema, 'params'),
  validate(UpdateWarehouseRequestSchema),
  inventoryController.updateWarehouse,
);
inventoryRouter.delete(
  '/warehouses/:id',
  rbacFor('inventory.warehouse.manage'),
  validate(WarehouseIdParamSchema, 'params'),
  inventoryController.deleteWarehouse,
);

// -------- Categories --------
inventoryRouter.get(
  '/categories',
  rbacFor('inventory.item.read'),
  validate(ListItemCategoriesQuerySchema, 'query'),
  inventoryController.listCategories,
);
inventoryRouter.post(
  '/categories',
  rbacFor('inventory.item.create'),
  idempotencyKey,
  validate(CreateItemCategoryRequestSchema),
  inventoryController.createCategory,
);
inventoryRouter.get(
  '/categories/:id',
  rbacFor('inventory.item.read'),
  validate(CategoryIdParamSchema, 'params'),
  inventoryController.getCategory,
);
inventoryRouter.patch(
  '/categories/:id',
  rbacFor('inventory.item.update'),
  validate(CategoryIdParamSchema, 'params'),
  validate(UpdateItemCategoryRequestSchema),
  inventoryController.updateCategory,
);
inventoryRouter.delete(
  '/categories/:id',
  rbacFor('inventory.item.archive'),
  validate(CategoryIdParamSchema, 'params'),
  inventoryController.deleteCategory,
);

// -------- Low stock and bulk import (must precede /items/:id) --------
inventoryRouter.get(
  '/low-stock',
  rbacFor('inventory.item.read'),
  validate(LowStockQuerySchema, 'query'),
  inventoryController.listLowStock,
);
inventoryRouter.post(
  '/bulk-import',
  rbacFor('inventory.item.create'),
  idempotencyKey,
  validate(BulkImportRequestSchema),
  inventoryController.bulkImport,
);

// -------- Items --------
inventoryRouter.get(
  '/items',
  rbacFor('inventory.item.read'),
  validate(ListItemsQuerySchema, 'query'),
  inventoryController.listItems,
);
inventoryRouter.post(
  '/items',
  rbacFor('inventory.item.create'),
  idempotencyKey,
  validate(CreateItemRequestSchema),
  inventoryController.createItem,
);
inventoryRouter.get(
  '/items/:id',
  rbacFor('inventory.item.read'),
  validate(ItemIdParamSchema, 'params'),
  inventoryController.getItem,
);
inventoryRouter.patch(
  '/items/:id',
  rbacFor('inventory.item.update'),
  validate(ItemIdParamSchema, 'params'),
  validate(UpdateItemRequestSchema),
  inventoryController.updateItem,
);
inventoryRouter.delete(
  '/items/:id',
  rbacFor('inventory.item.archive'),
  validate(ItemIdParamSchema, 'params'),
  inventoryController.deleteItem,
);

// -------- Item-scoped stock operations --------
inventoryRouter.post(
  '/items/:id/adjust',
  rbacFor('inventory.movement.create'),
  idempotencyKey,
  validate(ItemIdParamSchema, 'params'),
  validate(StockAdjustmentRequestSchema),
  inventoryController.adjustStock,
);
inventoryRouter.post(
  '/items/:id/transfer',
  rbacFor('inventory.movement.create'),
  idempotencyKey,
  validate(ItemIdParamSchema, 'params'),
  validate(StockTransferRequestSchema),
  inventoryController.transferStock,
);
inventoryRouter.get(
  '/items/:id/history',
  rbacFor('inventory.item.read'),
  validate(ItemIdParamSchema, 'params'),
  validate(ItemHistoryQuerySchema, 'query'),
  inventoryController.getItemHistory,
);
inventoryRouter.get(
  '/items/:id/balances',
  rbacFor('inventory.item.read'),
  validate(ItemIdParamSchema, 'params'),
  inventoryController.getItemBalances,
);
