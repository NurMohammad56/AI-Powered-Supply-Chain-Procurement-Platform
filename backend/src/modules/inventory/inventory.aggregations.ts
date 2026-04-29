import type { PipelineStage, Types } from 'mongoose';

import { StockMovement } from './models/stockMovement.model.js';
import { StockBalance } from './models/stockBalance.model.js';

/**
 * Aggregation pipelines owned by the inventory module. Tenant scoping
 * is mandatory and supplied as the first argument; the pipelines run
 * inside `tenantStorage.run({ tenantId })` from the caller, but the
 * tenant filter is also pushed into the pipeline as a defence-in-depth
 * `$match` stage.
 */

export interface InventoryTurnoverInput {
  tenantId: Types.ObjectId;
  rangeFrom: Date;
  rangeTo: Date;
  warehouseId?: Types.ObjectId;
}

export interface InventoryTurnoverRow {
  categoryId: Types.ObjectId | null;
  warehouseId: Types.ObjectId;
  itemId: Types.ObjectId;
  consumedUnits: number;
  averageBalance: number;
  turnoverRatio: number;
  daysOfCover: number | null;
  isSlowMover: boolean;
}

/**
 * Aggregate consumption (Stock OUT) per item over a date range,
 * cross-joined with the current balance, to produce a per-item turnover
 * ratio (FR-RPT-01). Items with zero consumption over the window are
 * flagged as slow movers.
 */
export async function inventoryTurnover(
  input: InventoryTurnoverInput,
): Promise<InventoryTurnoverRow[]> {
  const periodDays = Math.max(
    1,
    Math.round((input.rangeTo.getTime() - input.rangeFrom.getTime()) / (24 * 60 * 60 * 1000)),
  );

  const pipeline: PipelineStage[] = [
    {
      $match: {
        tenantId: input.tenantId,
        performedAt: { $gte: input.rangeFrom, $lte: input.rangeTo },
        type: { $in: ['out', 'transfer_out'] },
        ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
      },
    },
    {
      $group: {
        _id: { itemId: '$itemId', warehouseId: '$warehouseId' },
        consumedUnits: { $sum: { $abs: '$quantity' } },
      },
    },
    {
      $lookup: {
        from: 'stockbalances',
        let: { itemId: '$_id.itemId', warehouseId: '$_id.warehouseId', tenantId: input.tenantId },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$tenantId', '$$tenantId'] },
                  { $eq: ['$itemId', '$$itemId'] },
                  { $eq: ['$warehouseId', '$$warehouseId'] },
                ],
              },
            },
          },
          { $project: { quantity: 1 } },
        ],
        as: 'balance',
      },
    },
    {
      $lookup: {
        from: 'items',
        localField: '_id.itemId',
        foreignField: '_id',
        pipeline: [{ $project: { categoryId: 1, name: 1, sku: 1 } }],
        as: 'item',
      },
    },
    { $unwind: { path: '$item', preserveNullAndEmptyArrays: true } },
    { $unwind: { path: '$balance', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        itemId: '$_id.itemId',
        warehouseId: '$_id.warehouseId',
        categoryId: { $ifNull: ['$item.categoryId', null] },
        consumedUnits: 1,
        averageBalance: { $ifNull: ['$balance.quantity', 0] },
        turnoverRatio: {
          $cond: [
            { $gt: [{ $ifNull: ['$balance.quantity', 0] }, 0] },
            { $divide: ['$consumedUnits', '$balance.quantity'] },
            0,
          ],
        },
        daysOfCover: {
          $cond: [
            { $gt: ['$consumedUnits', 0] },
            {
              $divide: [
                { $multiply: [{ $ifNull: ['$balance.quantity', 0] }, periodDays] },
                '$consumedUnits',
              ],
            },
            null,
          ],
        },
        isSlowMover: { $eq: ['$consumedUnits', 0] },
      },
    },
    { $sort: { turnoverRatio: -1 } },
  ];

  return StockMovement.aggregate<InventoryTurnoverRow>(pipeline).exec();
}

export interface StockReconciliationInput {
  tenantId: Types.ObjectId;
  warehouseId?: Types.ObjectId;
}

export interface StockReconciliationRow {
  itemId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  cachedQuantity: number;
  ledgerQuantity: number;
  drift: number;
  needsReconciliation: boolean;
}

/**
 * Compares each `stockBalances` entry to the sum of its `stockMovements`
 * ledger. The weekly `inventory.balance_audit` cron uses this to detect
 * drift caused by partial writes or out-of-band edits (SDD §5.4.1).
 */
export async function reconcileStockBalances(
  input: StockReconciliationInput,
): Promise<StockReconciliationRow[]> {
  const pipeline: PipelineStage[] = [
    {
      $match: {
        tenantId: input.tenantId,
        ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
      },
    },
    {
      $lookup: {
        from: 'stockmovements',
        let: { itemId: '$itemId', warehouseId: '$warehouseId', tenantId: input.tenantId },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$tenantId', '$$tenantId'] },
                  { $eq: ['$itemId', '$$itemId'] },
                  { $eq: ['$warehouseId', '$$warehouseId'] },
                ],
              },
            },
          },
          { $group: { _id: null, sum: { $sum: '$quantity' } } },
        ],
        as: 'ledger',
      },
    },
    { $unwind: { path: '$ledger', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        itemId: 1,
        warehouseId: 1,
        cachedQuantity: '$quantity',
        ledgerQuantity: { $ifNull: ['$ledger.sum', 0] },
        drift: { $subtract: ['$quantity', { $ifNull: ['$ledger.sum', 0] }] },
        needsReconciliation: {
          $ne: ['$quantity', { $ifNull: ['$ledger.sum', 0] }],
        },
      },
    },
    { $match: { needsReconciliation: true } },
    { $sort: { drift: -1 } },
  ];

  return StockBalance.aggregate<StockReconciliationRow>(pipeline).exec();
}
