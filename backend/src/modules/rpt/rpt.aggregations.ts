import { Types, type PipelineStage } from 'mongoose';

import { StockMovement } from '../inventory/models/stockMovement.model.js';
import { StockBalance } from '../inventory/models/stockBalance.model.js';
import { PurchaseOrder } from '../po/models/purchaseOrder.model.js';

/**
 * Five canonical analytics pipelines (SDD §3.6 reporting). The tenancy
 * plugin auto-prepends `$match: { tenantId }` from AsyncLocalStorage; the
 * pipelines below carry their own explicit `tenantId` filter as the
 * leading `$match` because some are invoked from cron contexts where
 * the scope is established programmatically.
 *
 * All pipelines:
 *   - Lead with `tenantId` filter (index-friendly).
 *   - Project minimally; downstream code adds field plucks if needed.
 *   - Use `$facet` only where two distinct projections must run on the
 *     same input set in a single round-trip.
 */

export interface PipelineRangeArgs {
  tenantId: Types.ObjectId;
  from: Date;
  to: Date;
}

// 1) Inventory turnover ratio per item category over a period
//    Turnover = total OUT quantity / average on-hand quantity
//    Surfaces slow-moving and dead-stock candidates.
export function inventoryTurnoverByCategoryPipeline(args: PipelineRangeArgs): PipelineStage[] {
  return [
    {
      $match: {
        tenantId: args.tenantId,
        performedAt: { $gte: args.from, $lt: args.to },
        type: { $in: ['out', 'transfer_out'] },
      },
    },
    {
      $lookup: {
        from: 'items',
        localField: 'itemId',
        foreignField: '_id',
        as: 'item',
        pipeline: [{ $project: { categoryId: 1, sku: 1, name: 1, type: 1 } }],
      },
    },
    { $unwind: { path: '$item', preserveNullAndEmptyArrays: false } },
    {
      $group: {
        _id: '$item.categoryId',
        totalIssued: { $sum: { $abs: '$quantity' } },
        movementCount: { $sum: 1 },
        skuSet: { $addToSet: '$item._id' },
      },
    },
    {
      $lookup: {
        from: 'stockbalances',
        let: { categoryId: '$_id' },
        pipeline: [
          { $match: { tenantId: args.tenantId } },
          {
            $lookup: {
              from: 'items',
              localField: 'itemId',
              foreignField: '_id',
              as: 'item',
              pipeline: [{ $project: { categoryId: 1 } }],
            },
          },
          { $unwind: '$item' },
          { $match: { $expr: { $eq: ['$item.categoryId', '$$categoryId'] } } },
          { $group: { _id: null, avgQuantity: { $avg: '$quantity' } } },
        ],
        as: 'balance',
      },
    },
    {
      $project: {
        categoryId: '$_id',
        totalIssued: 1,
        movementCount: 1,
        skuCount: { $size: '$skuSet' },
        avgOnHand: { $ifNull: [{ $first: '$balance.avgQuantity' }, 0] },
        turnoverRatio: {
          $cond: [
            { $gt: [{ $first: '$balance.avgQuantity' }, 0] },
            { $divide: ['$totalIssued', { $first: '$balance.avgQuantity' }] },
            null,
          ],
        },
      },
    },
    { $sort: { turnoverRatio: 1 } },
  ];
}

// 2) Procurement spend by supplier with month-over-month delta
//    Powers the "supplier spend drill-through" tile on the dashboard.
export function spendBySupplierPipeline(args: PipelineRangeArgs): PipelineStage[] {
  return [
    {
      $match: {
        tenantId: args.tenantId,
        state: { $in: ['approved', 'sent', 'partially_received', 'fully_received', 'closed'] },
        createdAt: { $gte: args.from, $lt: args.to },
      },
    },
    {
      $group: {
        _id: {
          supplierId: '$supplierId',
          month: { $dateTrunc: { date: '$createdAt', unit: 'month' } },
        },
        spend: { $sum: '$totals.total' },
        poCount: { $sum: 1 },
      },
    },
    {
      $group: {
        _id: '$_id.supplierId',
        months: {
          $push: {
            month: '$_id.month',
            spend: '$spend',
            poCount: '$poCount',
          },
        },
        totalSpend: { $sum: '$spend' },
        totalPoCount: { $sum: '$poCount' },
      },
    },
    {
      $lookup: {
        from: 'suppliers',
        localField: '_id',
        foreignField: '_id',
        as: 'supplier',
        pipeline: [{ $project: { legalName: 1, tier: 1, performanceScore: 1 } }],
      },
    },
    { $unwind: '$supplier' },
    {
      $project: {
        supplierId: '$_id',
        supplierName: '$supplier.legalName',
        tier: '$supplier.tier',
        performanceScore: '$supplier.performanceScore.overall',
        months: 1,
        totalSpend: 1,
        totalPoCount: 1,
      },
    },
    { $sort: { totalSpend: -1 } },
  ];
}

// 3) Supplier cost comparison: same item bought from multiple suppliers
//    Surfaces savings opportunities where switching suppliers would lower cost.
export function supplierCostComparisonPipeline(args: PipelineRangeArgs): PipelineStage[] {
  return [
    {
      $match: {
        tenantId: args.tenantId,
        state: { $in: ['approved', 'sent', 'partially_received', 'fully_received', 'closed'] },
        createdAt: { $gte: args.from, $lt: args.to },
      },
    },
    { $unwind: '$lines' },
    {
      $group: {
        _id: { itemId: '$lines.itemId', supplierId: '$supplierId' },
        avgUnitPrice: { $avg: '$lines.unitPrice' },
        totalQuantity: { $sum: '$lines.quantityOrdered' },
        currency: { $first: '$currency' },
        sku: { $first: '$lines.itemSnapshot.sku' },
        itemName: { $first: '$lines.itemSnapshot.name' },
      },
    },
    {
      $group: {
        _id: '$_id.itemId',
        sku: { $first: '$sku' },
        itemName: { $first: '$itemName' },
        currency: { $first: '$currency' },
        suppliers: {
          $push: {
            supplierId: '$_id.supplierId',
            avgUnitPrice: '$avgUnitPrice',
            totalQuantity: '$totalQuantity',
          },
        },
        supplierCount: { $sum: 1 },
        cheapestPrice: { $min: '$avgUnitPrice' },
        mostExpensivePrice: { $max: '$avgUnitPrice' },
      },
    },
    { $match: { supplierCount: { $gte: 2 } } },
    {
      $project: {
        itemId: '$_id',
        sku: 1,
        itemName: 1,
        currency: 1,
        suppliers: 1,
        supplierCount: 1,
        cheapestPrice: 1,
        mostExpensivePrice: 1,
        priceSpread: {
          $subtract: ['$mostExpensivePrice', '$cheapestPrice'],
        },
        savingsPotentialPct: {
          $cond: [
            { $gt: ['$mostExpensivePrice', 0] },
            {
              $multiply: [
                { $divide: [{ $subtract: ['$mostExpensivePrice', '$cheapestPrice'] }, '$mostExpensivePrice'] },
                100,
              ],
            },
            0,
          ],
        },
      },
    },
    { $sort: { savingsPotentialPct: -1 } },
  ];
}

// 4) Forward-looking 90-day cash-flow projection of payables
//    Driven by Sent / Partially Received POs combined with payment-term days.
export function cashFlowProjectionPipeline(args: { tenantId: Types.ObjectId }): PipelineStage[] {
  const today = new Date();
  const horizonEnd = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000);
  return [
    {
      $match: {
        tenantId: args.tenantId,
        state: { $in: ['sent', 'partially_received'] },
        expectedDeliveryAt: { $gte: today, $lte: horizonEnd },
      },
    },
    {
      $project: {
        supplierId: 1,
        currency: 1,
        amount: '$totals.total',
        // Payable date = expectedDelivery + paymentTermsDays
        payableAt: {
          $dateAdd: {
            startDate: '$expectedDeliveryAt',
            unit: 'day',
            amount: { $ifNull: ['$paymentTermsDays', 0] },
          },
        },
      },
    },
    {
      $group: {
        _id: { $dateTrunc: { date: '$payableAt', unit: 'week' } },
        weekStart: { $first: { $dateTrunc: { date: '$payableAt', unit: 'week' } } },
        amountBdt: {
          $sum: { $cond: [{ $eq: ['$currency', 'BDT'] }, '$amount', 0] },
        },
        amountUsd: {
          $sum: { $cond: [{ $eq: ['$currency', 'USD'] }, '$amount', 0] },
        },
        poCount: { $sum: 1 },
        suppliers: { $addToSet: '$supplierId' },
      },
    },
    {
      $project: {
        weekStart: 1,
        amountBdt: 1,
        amountUsd: 1,
        poCount: 1,
        supplierCount: { $size: '$suppliers' },
      },
    },
    { $sort: { weekStart: 1 } },
  ];
}

// 5) Slow-moving / dead-stock detection: items with zero or near-zero
//    movement over the period despite holding stock. Prioritises items
//    with the largest tied-up value.
export function deadStockPipeline(args: PipelineRangeArgs): PipelineStage[] {
  return [
    {
      $match: { tenantId: args.tenantId, quantity: { $gt: 0 } },
    },
    {
      $lookup: {
        from: 'stockmovements',
        let: { itemId: '$itemId', warehouseId: '$warehouseId' },
        pipeline: [
          {
            $match: {
              tenantId: args.tenantId,
              performedAt: { $gte: args.from, $lt: args.to },
              type: { $in: ['out', 'transfer_out'] },
              $expr: {
                $and: [
                  { $eq: ['$itemId', '$$itemId'] },
                  { $eq: ['$warehouseId', '$$warehouseId'] },
                ],
              },
            },
          },
          { $group: { _id: null, totalOut: { $sum: { $abs: '$quantity' } } } },
        ],
        as: 'movement',
      },
    },
    {
      $project: {
        itemId: 1,
        warehouseId: 1,
        quantity: 1,
        outInPeriod: { $ifNull: [{ $first: '$movement.totalOut' }, 0] },
        daysSinceLastMovement: {
          $cond: [
            { $ifNull: ['$lastMovementAt', false] },
            { $dateDiff: { startDate: '$lastMovementAt', endDate: '$$NOW', unit: 'day' } },
            null,
          ],
        },
      },
    },
    {
      $lookup: {
        from: 'items',
        localField: 'itemId',
        foreignField: '_id',
        as: 'item',
        pipeline: [
          { $project: { sku: 1, name: 1, movingAverageCost: 1, type: 1 } },
        ],
      },
    },
    { $unwind: '$item' },
    {
      $project: {
        itemId: 1,
        warehouseId: 1,
        sku: '$item.sku',
        name: '$item.name',
        type: '$item.type',
        quantity: 1,
        valueBdt: { $multiply: ['$quantity', '$item.movingAverageCost'] },
        outInPeriod: 1,
        daysSinceLastMovement: 1,
        isDeadStock: { $eq: ['$outInPeriod', 0] },
      },
    },
    { $match: { isDeadStock: true } },
    { $sort: { valueBdt: -1 } },
    { $limit: 200 },
  ];
}

// Convenience execution helpers
export async function runInventoryTurnover(args: PipelineRangeArgs): Promise<unknown[]> {
  return StockMovement.aggregate(inventoryTurnoverByCategoryPipeline(args)).exec();
}

export async function runSpendBySupplier(args: PipelineRangeArgs): Promise<unknown[]> {
  return PurchaseOrder.aggregate(spendBySupplierPipeline(args)).exec();
}

export async function runSupplierCostComparison(args: PipelineRangeArgs): Promise<unknown[]> {
  return PurchaseOrder.aggregate(supplierCostComparisonPipeline(args)).exec();
}

export async function runCashFlowProjection(args: {
  tenantId: Types.ObjectId;
}): Promise<unknown[]> {
  return PurchaseOrder.aggregate(cashFlowProjectionPipeline(args)).exec();
}

export async function runDeadStock(args: PipelineRangeArgs): Promise<unknown[]> {
  return StockBalance.aggregate(deadStockPipeline(args)).exec();
}
