import { Types, type FilterQuery } from 'mongoose';

import { decodeCursor, paginate, type Page } from '../../shared/utils/pagination.js';
import { Item, type ItemDoc } from './models/item.model.js';
import { ItemCategory, type ItemCategoryDoc } from './models/itemCategory.model.js';
import { Warehouse, type WarehouseDoc } from './models/warehouse.model.js';
import { StockBalance, type StockBalanceDoc } from './models/stockBalance.model.js';
import { StockMovement, type StockMovementDoc } from './models/stockMovement.model.js';

export class InventoryRepository {
  // ----- Warehouses -----
  async findWarehouseById(id: Types.ObjectId | string): Promise<WarehouseDoc | null> {
    return Warehouse.findById(id).lean<WarehouseDoc>().exec();
  }
  async findWarehouseByCode(code: string): Promise<WarehouseDoc | null> {
    return Warehouse.findOne({ code: code.toUpperCase() }).lean<WarehouseDoc>().exec();
  }
  async createWarehouse(input: Partial<WarehouseDoc>): Promise<WarehouseDoc> {
    const doc = await Warehouse.create(input);
    return doc.toObject();
  }
  async updateWarehouse(id: Types.ObjectId, patch: Partial<WarehouseDoc>): Promise<WarehouseDoc | null> {
    return Warehouse.findByIdAndUpdate(id, patch, { new: true, runValidators: true })
      .lean<WarehouseDoc>()
      .exec();
  }
  async archiveWarehouse(id: Types.ObjectId): Promise<boolean> {
    const result = await Warehouse.updateOne({ _id: id }, { $set: { archivedAt: new Date() } }).exec();
    return (result.modifiedCount ?? 0) > 0;
  }
  async listWarehouses(args: {
    cursor?: string;
    limit: number;
    isActive?: boolean;
    q?: string;
  }): Promise<Page<WarehouseDoc>> {
    const filter: FilterQuery<WarehouseDoc> = {};
    if (args.isActive !== undefined) filter.isActive = args.isActive;
    if (args.q) filter.name = new RegExp(args.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const after = decodeCursor(args.cursor);
    if (after) filter._id = { $gt: after };
    const rows = await Warehouse.find(filter)
      .sort({ _id: 1 })
      .limit(args.limit + 1)
      .lean<WarehouseDoc[]>()
      .exec();
    return paginate(rows, args.limit);
  }

  // ----- Item Categories -----
  async findCategoryById(id: Types.ObjectId | string): Promise<ItemCategoryDoc | null> {
    return ItemCategory.findById(id).lean<ItemCategoryDoc>().exec();
  }
  async findCategoryByName(name: string): Promise<ItemCategoryDoc | null> {
    return ItemCategory.findOne({ name }).lean<ItemCategoryDoc>().exec();
  }
  async createCategory(input: Partial<ItemCategoryDoc>): Promise<ItemCategoryDoc> {
    const doc = await ItemCategory.create(input);
    return doc.toObject();
  }
  async updateCategory(
    id: Types.ObjectId,
    patch: Partial<ItemCategoryDoc>,
  ): Promise<ItemCategoryDoc | null> {
    return ItemCategory.findByIdAndUpdate(id, patch, { new: true, runValidators: true })
      .lean<ItemCategoryDoc>()
      .exec();
  }
  async archiveCategory(id: Types.ObjectId): Promise<boolean> {
    const result = await ItemCategory.updateOne(
      { _id: id },
      { $set: { archivedAt: new Date() } },
    ).exec();
    return (result.modifiedCount ?? 0) > 0;
  }
  async listCategories(args: {
    cursor?: string;
    limit: number;
    parentId?: string;
    q?: string;
  }): Promise<Page<ItemCategoryDoc>> {
    const filter: FilterQuery<ItemCategoryDoc> = {};
    if (args.parentId) filter.parentId = new Types.ObjectId(args.parentId);
    if (args.q) filter.name = new RegExp(args.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const after = decodeCursor(args.cursor);
    if (after) filter._id = { $gt: after };
    const rows = await ItemCategory.find(filter)
      .sort({ _id: 1 })
      .limit(args.limit + 1)
      .lean<ItemCategoryDoc[]>()
      .exec();
    return paginate(rows, args.limit);
  }

  // ----- Items -----
  async findItemById(id: Types.ObjectId | string): Promise<ItemDoc | null> {
    return Item.findById(id).lean<ItemDoc>().exec();
  }
  async findItemBySku(sku: string): Promise<ItemDoc | null> {
    return Item.findOne({ sku: sku.toUpperCase() }).lean<ItemDoc>().exec();
  }
  async createItem(input: Partial<ItemDoc>): Promise<ItemDoc> {
    const doc = await Item.create(input);
    return doc.toObject();
  }
  async updateItem(id: Types.ObjectId, patch: Partial<ItemDoc>): Promise<ItemDoc | null> {
    return Item.findByIdAndUpdate(id, patch, { new: true, runValidators: true })
      .lean<ItemDoc>()
      .exec();
  }
  async archiveItem(id: Types.ObjectId): Promise<boolean> {
    const result = await Item.updateOne({ _id: id }, { $set: { archivedAt: new Date() } }).exec();
    return (result.modifiedCount ?? 0) > 0;
  }
  async listItems(args: {
    cursor?: string;
    limit: number;
    q?: string;
    type?: string;
    categoryId?: string;
    supplierId?: string;
    archived?: boolean;
  }): Promise<Page<ItemDoc>> {
    const filter: FilterQuery<ItemDoc> = {};
    if (args.type) filter.type = args.type;
    if (args.categoryId) filter.categoryId = new Types.ObjectId(args.categoryId);
    if (args.supplierId) filter.preferredSupplierId = new Types.ObjectId(args.supplierId);
    if (args.q) {
      const escaped = args.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { sku: new RegExp(escaped, 'i') },
        { name: new RegExp(escaped, 'i') },
      ];
    }
    if (args.archived === true) {
      filter.archivedAt = { $type: 'date' };
    } else if (args.archived === false) {
      filter.archivedAt = null;
    }
    const after = decodeCursor(args.cursor);
    if (after) filter._id = { $gt: after };
    const rows = await Item.find(filter)
      .sort({ _id: 1 })
      .limit(args.limit + 1)
      .lean<ItemDoc[]>()
      .exec();
    return paginate(rows, args.limit);
  }

  // ----- Stock Balance -----
  async findBalance(
    itemId: Types.ObjectId,
    warehouseId: Types.ObjectId,
  ): Promise<StockBalanceDoc | null> {
    return StockBalance.findOne({ itemId, warehouseId }).lean<StockBalanceDoc>().exec();
  }
  async listBalancesForItem(itemId: Types.ObjectId): Promise<StockBalanceDoc[]> {
    return StockBalance.find({ itemId }).lean<StockBalanceDoc[]>().exec();
  }
  /**
   * CAS upsert: increments quantity by delta atomically. Uses
   * findOneAndUpdate with version-based optimistic locking when an
   * existing balance row exists; creates a fresh row when none exists.
   *
   * Returns the new balance row. Throws on negative-stock violation
   * (caller should check `allowNegative` first).
   */
  async incrementBalance(args: {
    itemId: Types.ObjectId;
    warehouseId: Types.ObjectId;
    delta: number;
    movementAt: Date;
  }): Promise<StockBalanceDoc> {
    const updated = await StockBalance.findOneAndUpdate(
      { itemId: args.itemId, warehouseId: args.warehouseId },
      {
        $inc: { quantity: args.delta, version: 1 },
        $set: { lastMovementAt: args.movementAt },
        $setOnInsert: { reservedQuantity: 0, reorderLevelOverride: null, lowStockSince: null },
      },
      { upsert: true, new: true, runValidators: true },
    )
      .lean<StockBalanceDoc>()
      .exec();
    if (!updated) throw new Error('Failed to update stock balance');
    return updated;
  }

  /**
   * Clear `lowStockSince` on a balance row whose quantity has risen back
   * above the item's reorder level. Returns true when an alert was
   * actively cleared, false otherwise. Idempotent.
   */
  async clearLowStockIfResolved(args: {
    itemId: Types.ObjectId;
    warehouseId: Types.ObjectId;
    reorderLevel: number;
  }): Promise<boolean> {
    const result = await StockBalance.updateOne(
      {
        itemId: args.itemId,
        warehouseId: args.warehouseId,
        lowStockSince: { $type: 'date' },
        quantity: { $gte: args.reorderLevel },
      },
      { $set: { lowStockSince: null } },
    ).exec();
    return (result.modifiedCount ?? 0) > 0;
  }

  async listLowStock(args: {
    cursor?: string;
    limit: number;
    warehouseId?: string;
  }): Promise<Page<StockBalanceDoc>> {
    const filter: FilterQuery<StockBalanceDoc> = { lowStockSince: { $type: 'date' } };
    if (args.warehouseId) filter.warehouseId = new Types.ObjectId(args.warehouseId);
    const after = decodeCursor(args.cursor);
    if (after) filter._id = { $gt: after };
    const rows = await StockBalance.find(filter)
      .sort({ _id: 1 })
      .limit(args.limit + 1)
      .lean<StockBalanceDoc[]>()
      .exec();
    return paginate(rows, args.limit);
  }

  // ----- Stock Movements -----
  async createMovement(input: Partial<StockMovementDoc>): Promise<StockMovementDoc> {
    const doc = await StockMovement.create(input);
    return doc.toObject();
  }

  async listMovementsForItem(args: {
    itemId: Types.ObjectId;
    cursor?: string;
    limit: number;
    warehouseId?: string;
    from?: Date;
    to?: Date;
    type?: string;
  }): Promise<Page<StockMovementDoc>> {
    const filter: FilterQuery<StockMovementDoc> = { itemId: args.itemId };
    if (args.warehouseId) filter.warehouseId = new Types.ObjectId(args.warehouseId);
    if (args.from || args.to) {
      filter.performedAt = {};
      if (args.from) (filter.performedAt as Record<string, Date>).$gte = args.from;
      if (args.to) (filter.performedAt as Record<string, Date>).$lte = args.to;
    }
    if (args.type) filter.type = args.type;
    const after = decodeCursor(args.cursor);
    if (after) filter._id = { $gt: after };
    const rows = await StockMovement.find(filter)
      .sort({ _id: 1 })
      .limit(args.limit + 1)
      .lean<StockMovementDoc[]>()
      .exec();
    return paginate(rows, args.limit);
  }
}

export const inventoryRepository = new InventoryRepository();
