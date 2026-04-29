import { Types } from 'mongoose';

import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../../shared/errors/HttpErrors.js';
import { ErrorCodes } from '../../shared/errors/errorCodes.js';
import { assertTenantOwns } from '../../shared/auth/assertTenantOwns.js';
import { recordAudit, AuditActions } from '../../shared/audit/index.js';
import type { TenantContext } from '../../shared/auth/types.js';
import type { Page } from '../../shared/utils/pagination.js';
import { inventoryRepository } from './inventory.repository.js';
import type { ItemDoc } from './models/item.model.js';
import type { ItemCategoryDoc } from './models/itemCategory.model.js';
import type { WarehouseDoc } from './models/warehouse.model.js';
import type { StockBalanceDoc } from './models/stockBalance.model.js';
import type { StockMovementDoc } from './models/stockMovement.model.js';
import type {
  CreateItemRequest,
  CreateItemCategoryRequest,
  CreateWarehouseRequest,
  ItemView,
  ItemCategoryView,
  WarehouseView,
  StockAdjustmentRequest,
  StockTransferRequest,
  ItemHistoryQuery,
  ListItemsQuery,
  ListWarehousesQuery,
  ListItemCategoriesQuery,
  LowStockQuery,
  StockBalanceView,
  StockMovementView,
  UpdateItemRequest,
  UpdateItemCategoryRequest,
  UpdateWarehouseRequest,
  BulkImportRequest,
  BulkImportResult,
} from './inventory.dto.js';

function toWarehouseView(w: WarehouseDoc): WarehouseView {
  return {
    id: w._id.toString(),
    name: w.name,
    code: w.code,
    address: w.address
      ? {
          street: w.address.street,
          city: w.address.city,
          country: w.address.country,
          postalCode: w.address.postalCode ?? null,
        }
      : null,
    isActive: w.isActive,
    archivedAt: w.archivedAt ? w.archivedAt.toISOString() : null,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

function toCategoryView(c: ItemCategoryDoc): ItemCategoryView {
  return {
    id: c._id.toString(),
    name: c.name,
    parentId: c.parentId ? c.parentId.toString() : null,
    description: c.description,
    archivedAt: c.archivedAt ? c.archivedAt.toISOString() : null,
  };
}

function toItemView(i: ItemDoc): ItemView {
  return {
    id: i._id.toString(),
    sku: i.sku,
    barcode: i.barcode,
    name: i.name,
    description: i.description,
    categoryId: i.categoryId ? i.categoryId.toString() : null,
    unit: i.unit,
    type: i.type,
    preferredSupplierId: i.preferredSupplierId ? i.preferredSupplierId.toString() : null,
    reorderLevel: i.reorderLevel,
    movingAverageCost: i.movingAverageCost,
    currency: i.currency,
    archivedAt: i.archivedAt ? i.archivedAt.toISOString() : null,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}

function toBalanceView(b: StockBalanceDoc): StockBalanceView {
  return {
    itemId: b.itemId.toString(),
    warehouseId: b.warehouseId.toString(),
    quantity: b.quantity,
    reservedQuantity: b.reservedQuantity,
    reorderLevelOverride: b.reorderLevelOverride,
    lowStockSince: b.lowStockSince ? b.lowStockSince.toISOString() : null,
    lastMovementAt: b.lastMovementAt ? b.lastMovementAt.toISOString() : null,
  };
}

function toMovementView(m: StockMovementDoc): StockMovementView {
  return {
    id: m._id.toString(),
    itemId: m.itemId.toString(),
    warehouseId: m.warehouseId.toString(),
    type: m.type,
    quantity: m.quantity,
    unitCost: m.unitCost,
    reasonCode: m.reasonCode,
    reference: {
      kind: m.reference.kind,
      id: m.reference.id ? m.reference.id.toString() : null,
    },
    attachmentUrl: m.attachmentUrl,
    performedBy: m.performedBy.toString(),
    performedAt: m.performedAt.toISOString(),
  };
}

function pagedView<T, V>(page: Page<T>, mapper: (row: T) => V): {
  rows: V[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
} {
  return {
    rows: page.rows.map(mapper),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    limit: page.limit,
  };
}

export class InventoryService {
  // =========================== Warehouses ===========================
  async createWarehouse(ctx: TenantContext, input: CreateWarehouseRequest): Promise<WarehouseView> {
    const dup = await inventoryRepository.findWarehouseByCode(input.code);
    if (dup) throw new ConflictError(ErrorCodes.RESOURCE_DUPLICATE, 'Warehouse code already exists');
    const created = await inventoryRepository.createWarehouse({
      name: input.name,
      code: input.code,
      address: input.address
        ? {
            street: input.address.street,
            city: input.address.city,
            country: input.address.country,
            postalCode: input.address.postalCode ?? null,
          }
        : null,
      isActive: input.isActive ?? true,
    });
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.InventoryWarehouseCreated,
      target: { kind: 'warehouse', id: created._id },
      requestId: ctx.requestId,
    });
    return toWarehouseView(created);
  }

  async getWarehouse(ctx: TenantContext, id: Types.ObjectId): Promise<WarehouseView> {
    const w = await inventoryRepository.findWarehouseById(id);
    assertTenantOwns(w, ctx);
    return toWarehouseView(w);
  }

  async updateWarehouse(
    ctx: TenantContext,
    id: Types.ObjectId,
    patch: UpdateWarehouseRequest,
  ): Promise<WarehouseView> {
    const w = await inventoryRepository.findWarehouseById(id);
    assertTenantOwns(w, ctx);
    if (patch.code && patch.code !== w.code) {
      const dup = await inventoryRepository.findWarehouseByCode(patch.code);
      if (dup) throw new ConflictError(ErrorCodes.RESOURCE_DUPLICATE, 'Warehouse code already exists');
    }
    const update: Partial<WarehouseDoc> = {};
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.code !== undefined) update.code = patch.code;
    if (patch.isActive !== undefined) update.isActive = patch.isActive;
    if (patch.address !== undefined) {
      update.address = patch.address
        ? {
            street: patch.address.street,
            city: patch.address.city,
            country: patch.address.country,
            postalCode: patch.address.postalCode ?? null,
          }
        : null;
    }
    const updated = await inventoryRepository.updateWarehouse(id, update);
    if (!updated) throw new NotFoundError();
    return toWarehouseView(updated);
  }

  async archiveWarehouse(ctx: TenantContext, id: Types.ObjectId): Promise<void> {
    const w = await inventoryRepository.findWarehouseById(id);
    assertTenantOwns(w, ctx);
    await inventoryRepository.archiveWarehouse(id);
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.InventoryWarehouseArchived,
      target: { kind: 'warehouse', id },
      requestId: ctx.requestId,
    });
  }

  async listWarehouses(_ctx: TenantContext, query: ListWarehousesQuery) {
    const page = await inventoryRepository.listWarehouses(query);
    return pagedView(page, toWarehouseView);
  }

  // =========================== Categories ===========================
  async createCategory(
    ctx: TenantContext,
    input: CreateItemCategoryRequest,
  ): Promise<ItemCategoryView> {
    const dup = await inventoryRepository.findCategoryByName(input.name);
    if (dup) throw new ConflictError(ErrorCodes.RESOURCE_DUPLICATE, 'Category name already exists');
    const created = await inventoryRepository.createCategory({
      name: input.name,
      parentId: input.parentId ? new Types.ObjectId(input.parentId) : null,
      description: input.description ?? null,
    });
    return toCategoryView(created);
  }

  async getCategory(ctx: TenantContext, id: Types.ObjectId): Promise<ItemCategoryView> {
    const c = await inventoryRepository.findCategoryById(id);
    assertTenantOwns(c, ctx);
    return toCategoryView(c);
  }

  async updateCategory(
    ctx: TenantContext,
    id: Types.ObjectId,
    patch: UpdateItemCategoryRequest,
  ): Promise<ItemCategoryView> {
    const c = await inventoryRepository.findCategoryById(id);
    assertTenantOwns(c, ctx);
    const update: Partial<ItemCategoryDoc> = {};
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.parentId !== undefined) {
      update.parentId = patch.parentId ? new Types.ObjectId(patch.parentId) : null;
    }
    if (patch.description !== undefined) update.description = patch.description ?? null;
    const updated = await inventoryRepository.updateCategory(id, update);
    if (!updated) throw new NotFoundError();
    return toCategoryView(updated);
  }

  async archiveCategory(ctx: TenantContext, id: Types.ObjectId): Promise<void> {
    const c = await inventoryRepository.findCategoryById(id);
    assertTenantOwns(c, ctx);
    await inventoryRepository.archiveCategory(id);
  }

  async listCategories(_ctx: TenantContext, query: ListItemCategoriesQuery) {
    const page = await inventoryRepository.listCategories(query);
    return pagedView(page, toCategoryView);
  }

  // ============================= Items =============================
  async createItem(ctx: TenantContext, input: CreateItemRequest): Promise<ItemView> {
    const dup = await inventoryRepository.findItemBySku(input.sku);
    if (dup) throw new ConflictError(ErrorCodes.RESOURCE_DUPLICATE, 'SKU already exists');
    const created = await inventoryRepository.createItem({
      sku: input.sku,
      barcode: input.barcode ?? null,
      name: input.name,
      description: input.description ?? null,
      categoryId: input.categoryId ? new Types.ObjectId(input.categoryId) : null,
      unit: input.unit as ItemDoc['unit'],
      type: input.type as ItemDoc['type'],
      preferredSupplierId: input.preferredSupplierId
        ? new Types.ObjectId(input.preferredSupplierId)
        : null,
      reorderLevel: input.reorderLevel,
      movingAverageCost: input.movingAverageCost,
      currency: input.currency as ItemDoc['currency'],
    });
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.InventoryItemCreated,
      target: { kind: 'item', id: created._id },
      payload: { sku: created.sku, name: created.name },
      requestId: ctx.requestId,
    });
    return toItemView(created);
  }

  async getItem(ctx: TenantContext, id: Types.ObjectId): Promise<ItemView> {
    const i = await inventoryRepository.findItemById(id);
    assertTenantOwns(i, ctx);
    return toItemView(i);
  }

  async updateItem(
    ctx: TenantContext,
    id: Types.ObjectId,
    patch: UpdateItemRequest,
  ): Promise<ItemView> {
    const i = await inventoryRepository.findItemById(id);
    assertTenantOwns(i, ctx);
    if (patch.sku && patch.sku !== i.sku) {
      const dup = await inventoryRepository.findItemBySku(patch.sku);
      if (dup) throw new ConflictError(ErrorCodes.RESOURCE_DUPLICATE, 'SKU already exists');
    }
    const update: Partial<ItemDoc> = {};
    if (patch.sku !== undefined) update.sku = patch.sku;
    if (patch.barcode !== undefined) update.barcode = patch.barcode ?? null;
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.description !== undefined) update.description = patch.description ?? null;
    if (patch.categoryId !== undefined) {
      update.categoryId = patch.categoryId ? new Types.ObjectId(patch.categoryId) : null;
    }
    if (patch.unit !== undefined) update.unit = patch.unit as ItemDoc['unit'];
    if (patch.type !== undefined) update.type = patch.type as ItemDoc['type'];
    if (patch.preferredSupplierId !== undefined) {
      update.preferredSupplierId = patch.preferredSupplierId
        ? new Types.ObjectId(patch.preferredSupplierId)
        : null;
    }
    if (patch.reorderLevel !== undefined) update.reorderLevel = patch.reorderLevel;
    if (patch.movingAverageCost !== undefined) update.movingAverageCost = patch.movingAverageCost;
    if (patch.currency !== undefined) update.currency = patch.currency as ItemDoc['currency'];
    const updated = await inventoryRepository.updateItem(id, update);
    if (!updated) throw new NotFoundError();
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.InventoryItemUpdated,
      target: { kind: 'item', id },
      before: i,
      after: updated,
      requestId: ctx.requestId,
    });
    return toItemView(updated);
  }

  async archiveItem(ctx: TenantContext, id: Types.ObjectId): Promise<void> {
    const i = await inventoryRepository.findItemById(id);
    assertTenantOwns(i, ctx);
    await inventoryRepository.archiveItem(id);
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.InventoryItemArchived,
      target: { kind: 'item', id },
      requestId: ctx.requestId,
    });
  }

  async listItems(_ctx: TenantContext, query: ListItemsQuery) {
    const page = await inventoryRepository.listItems(query);
    return pagedView(page, toItemView);
  }

  // ========================= Stock movements =========================
  async adjustStock(
    ctx: TenantContext,
    itemId: Types.ObjectId,
    input: StockAdjustmentRequest,
  ): Promise<{ balance: StockBalanceView; movement: StockMovementView }> {
    const item = await inventoryRepository.findItemById(itemId);
    assertTenantOwns(item, ctx);

    const warehouseId = new Types.ObjectId(input.warehouseId);
    const warehouse = await inventoryRepository.findWarehouseById(warehouseId);
    assertTenantOwns(warehouse, ctx);

    if (input.quantityDelta < 0) {
      const current = await inventoryRepository.findBalance(itemId, warehouseId);
      const onHand = current?.quantity ?? 0;
      if (onHand + input.quantityDelta < 0) {
        throw new BadRequestError(
          ErrorCodes.STOCK_NEGATIVE_NOT_ALLOWED,
          'Adjustment would drive stock negative',
          { onHand, delta: input.quantityDelta },
        );
      }
    }

    const at = new Date();
    const movement = await inventoryRepository.createMovement({
      itemId,
      warehouseId,
      type: 'adjustment',
      quantity: input.quantityDelta,
      unitCost: null,
      reasonCode: input.reasonCode,
      reference: { kind: 'adjustment', id: null },
      attachmentUrl: input.attachmentUrl ?? null,
      performedBy: ctx.userId,
      performedAt: at,
    });

    const balance = await inventoryRepository.incrementBalance({
      itemId,
      warehouseId,
      delta: input.quantityDelta,
      movementAt: at,
    });

    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.InventoryMovementAdjustment,
      target: { kind: 'item', id: itemId },
      payload: {
        warehouseId: warehouseId.toString(),
        delta: input.quantityDelta,
        reasonCode: input.reasonCode,
      },
      requestId: ctx.requestId,
    });

    return { balance: toBalanceView(balance), movement: toMovementView(movement) };
  }

  async transferStock(
    ctx: TenantContext,
    itemId: Types.ObjectId,
    input: StockTransferRequest,
  ): Promise<{ outMovement: StockMovementView; inMovement: StockMovementView }> {
    if (input.fromWarehouseId === input.toWarehouseId) {
      throw new BadRequestError(ErrorCodes.BAD_REQUEST, 'Source and destination must differ');
    }
    const item = await inventoryRepository.findItemById(itemId);
    assertTenantOwns(item, ctx);

    const fromId = new Types.ObjectId(input.fromWarehouseId);
    const toId = new Types.ObjectId(input.toWarehouseId);
    const fromWh = await inventoryRepository.findWarehouseById(fromId);
    const toWh = await inventoryRepository.findWarehouseById(toId);
    assertTenantOwns(fromWh, ctx);
    assertTenantOwns(toWh, ctx);

    const current = await inventoryRepository.findBalance(itemId, fromId);
    if ((current?.quantity ?? 0) < input.quantity) {
      throw new BadRequestError(
        ErrorCodes.STOCK_INSUFFICIENT,
        'Insufficient stock at source warehouse',
        { onHand: current?.quantity ?? 0, requested: input.quantity },
      );
    }

    const at = new Date();
    const transferRef = new Types.ObjectId();

    const outMovement = await inventoryRepository.createMovement({
      itemId,
      warehouseId: fromId,
      type: 'transfer_out',
      quantity: -input.quantity,
      unitCost: null,
      reasonCode: 'transfer',
      reference: { kind: 'transfer', id: transferRef },
      attachmentUrl: null,
      performedBy: ctx.userId,
      performedAt: at,
    });
    const inMovement = await inventoryRepository.createMovement({
      itemId,
      warehouseId: toId,
      type: 'transfer_in',
      quantity: input.quantity,
      unitCost: null,
      reasonCode: 'transfer',
      reference: { kind: 'transfer', id: transferRef },
      attachmentUrl: null,
      performedBy: ctx.userId,
      performedAt: at,
    });

    await inventoryRepository.incrementBalance({
      itemId,
      warehouseId: fromId,
      delta: -input.quantity,
      movementAt: at,
    });
    await inventoryRepository.incrementBalance({
      itemId,
      warehouseId: toId,
      delta: input.quantity,
      movementAt: at,
    });

    return {
      outMovement: toMovementView(outMovement),
      inMovement: toMovementView(inMovement),
    };
  }

  async getItemHistory(
    ctx: TenantContext,
    itemId: Types.ObjectId,
    query: ItemHistoryQuery,
  ) {
    const item = await inventoryRepository.findItemById(itemId);
    assertTenantOwns(item, ctx);
    const page = await inventoryRepository.listMovementsForItem({
      itemId,
      cursor: query.cursor,
      limit: query.limit,
      warehouseId: query.warehouseId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      type: query.type,
    });
    return pagedView(page, toMovementView);
  }

  async getItemBalances(
    ctx: TenantContext,
    itemId: Types.ObjectId,
  ): Promise<StockBalanceView[]> {
    const item = await inventoryRepository.findItemById(itemId);
    assertTenantOwns(item, ctx);
    const balances = await inventoryRepository.listBalancesForItem(itemId);
    return balances.map(toBalanceView);
  }

  async listLowStock(_ctx: TenantContext, query: LowStockQuery) {
    const page = await inventoryRepository.listLowStock(query);
    return pagedView(page, toBalanceView);
  }

  // =========================== Bulk Import ===========================
  async bulkImport(
    ctx: TenantContext,
    input: BulkImportRequest,
  ): Promise<BulkImportResult> {
    const errors: Array<{ row: number; sku: string; message: string }> = [];
    let imported = 0;
    let skipped = 0;

    for (let row = 0; row < input.items.length; row += 1) {
      const item = input.items[row];
      if (!item) continue;
      try {
        const sku = item.sku.toUpperCase();
        const existing = await inventoryRepository.findItemBySku(sku);
        if (existing) {
          if (input.atomic) {
            errors.push({ row, sku, message: 'SKU already exists' });
            return { imported: 0, skipped: 0, errors };
          }
          skipped += 1;
          continue;
        }
        let categoryId: Types.ObjectId | null = null;
        if (item.categoryName) {
          const cat = await inventoryRepository.findCategoryByName(item.categoryName);
          if (!cat) {
            const msg = `Unknown category name: ${item.categoryName}`;
            if (input.atomic) {
              errors.push({ row, sku, message: msg });
              return { imported: 0, skipped: 0, errors };
            }
            errors.push({ row, sku, message: msg });
            skipped += 1;
            continue;
          }
          categoryId = cat._id;
        }
        const created = await inventoryRepository.createItem({
          sku,
          name: item.name,
          unit: item.unit as ItemDoc['unit'],
          type: item.type as ItemDoc['type'],
          barcode: item.barcode ?? null,
          description: item.description ?? null,
          categoryId,
          reorderLevel: item.reorderLevel,
          preferredSupplierId: null,
          movingAverageCost: 0,
          currency: 'BDT',
        });
        if (item.openingBalance) {
          const wh = await inventoryRepository.findWarehouseByCode(
            item.openingBalance.warehouseCode,
          );
          if (wh && item.openingBalance.quantity > 0) {
            const at = new Date();
            await inventoryRepository.createMovement({
              itemId: created._id,
              warehouseId: wh._id,
              type: 'opening',
              quantity: item.openingBalance.quantity,
              unitCost: item.openingBalance.unitCost ?? null,
              reasonCode: 'opening',
              reference: { kind: 'opening', id: null },
              attachmentUrl: null,
              performedBy: ctx.userId,
              performedAt: at,
            });
            await inventoryRepository.incrementBalance({
              itemId: created._id,
              warehouseId: wh._id,
              delta: item.openingBalance.quantity,
              movementAt: at,
            });
          }
        }
        imported += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        const sku = item.sku.toUpperCase();
        if (input.atomic) {
          errors.push({ row, sku, message: msg });
          return { imported: 0, skipped: 0, errors };
        }
        errors.push({ row, sku, message: msg });
        skipped += 1;
      }
    }

    return { imported, skipped, errors };
  }
}

export const inventoryService = new InventoryService();
