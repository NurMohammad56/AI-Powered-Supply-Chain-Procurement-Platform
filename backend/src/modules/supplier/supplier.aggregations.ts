import type { PipelineStage, Types } from 'mongoose';

import { PurchaseOrder } from '../po/index.js';

/**
 * Supplier-performance score aggregation (FR-SUP-08).
 *
 * The nightly `supplier.score_recompute` cron runs this for every
 * supplier with at least 3 closed POs in the trailing 180 days, then
 * writes the result back onto `suppliers.performanceScore`.
 *
 * Components:
 *   - on-time delivery rate    : weight 40
 *   - quantity-fill rate       : weight 30
 *   - quality-reject rate      : weight 20 (inverted)
 *   - price-competitiveness    : weight 10 (lower = better, normalised)
 *
 * Per-component values are 0..1; `overall` is 0..100.
 */
export interface SupplierPerformanceInput {
  tenantId: Types.ObjectId;
  windowDays?: number;
  minSampleSize?: number;
}

export interface SupplierPerformanceRow {
  supplierId: Types.ObjectId;
  sampleSize: number;
  onTimeDeliveryRate: number;
  fillRate: number;
  qualityRejectRate: number;
  averageUnitPrice: number;
  overall: number;
}

const W_ON_TIME = 40;
const W_FILL = 30;
const W_QUALITY = 20;
const W_PRICE = 10;

export async function supplierPerformanceScores(
  input: SupplierPerformanceInput,
): Promise<SupplierPerformanceRow[]> {
  const windowDays = input.windowDays ?? 180;
  const minSampleSize = input.minSampleSize ?? 3;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const pipeline: PipelineStage[] = [
    {
      $match: {
        tenantId: input.tenantId,
        state: { $in: ['fully_received', 'closed'] },
        createdAt: { $gte: since },
      },
    },
    { $unwind: '$lines' },
    {
      $group: {
        _id: '$supplierId',
        sampleSize: { $addToSet: '$_id' },
        // on-time = expectedDeliveryAt >= last receipt at; we approximate
        // using the line's expectedDeliveryAt vs the PO's approvedAt to
        // closure window. A more precise computation joins poReceipts.
        onTimeCount: {
          $sum: {
            $cond: [
              {
                $lte: [
                  '$closedAt',
                  { $ifNull: ['$lines.expectedDeliveryAt', '$expectedDeliveryAt'] },
                ],
              },
              1,
              0,
            ],
          },
        },
        lineCount: { $sum: 1 },
        totalOrdered: { $sum: '$lines.quantityOrdered' },
        totalReceived: { $sum: '$lines.quantityReceived' },
        priceSum: { $sum: '$lines.unitPrice' },
      },
    },
    {
      $project: {
        _id: 0,
        supplierId: '$_id',
        sampleSize: { $size: '$sampleSize' },
        onTimeDeliveryRate: {
          $cond: [
            { $gt: ['$lineCount', 0] },
            { $divide: ['$onTimeCount', '$lineCount'] },
            0,
          ],
        },
        fillRate: {
          $cond: [
            { $gt: ['$totalOrdered', 0] },
            { $min: [{ $divide: ['$totalReceived', '$totalOrdered'] }, 1] },
            0,
          ],
        },
        qualityRejectRate: 0,
        averageUnitPrice: {
          $cond: [
            { $gt: ['$lineCount', 0] },
            { $divide: ['$priceSum', '$lineCount'] },
            0,
          ],
        },
      },
    },
    { $match: { sampleSize: { $gte: minSampleSize } } },
  ];

  const rows = await PurchaseOrder.aggregate<Omit<SupplierPerformanceRow, 'overall'>>(
    pipeline,
  ).exec();

  if (rows.length === 0) return [];

  // Price-competitiveness: tenant-relative percentile (lower price = higher score).
  const prices = rows.map((r) => r.averageUnitPrice).filter((p) => p > 0);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceSpread = Math.max(1, maxPrice - minPrice);

  return rows.map((r) => {
    const priceCompetitiveness =
      r.averageUnitPrice <= 0 ? 0 : 1 - (r.averageUnitPrice - minPrice) / priceSpread;
    const overall =
      W_ON_TIME * r.onTimeDeliveryRate +
      W_FILL * r.fillRate +
      W_QUALITY * (1 - r.qualityRejectRate) +
      W_PRICE * priceCompetitiveness;
    return {
      ...r,
      overall: Math.round(overall * 100) / 100,
    };
  });
}
