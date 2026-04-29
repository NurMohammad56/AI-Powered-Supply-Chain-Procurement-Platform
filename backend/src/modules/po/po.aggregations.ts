import { Types, type PipelineStage } from 'mongoose';

import { PurchaseOrder } from './models/purchaseOrder.model.js';

/**
 * Aggregation pipelines owned by the PO module: monthly procurement
 * spend (FR-RPT-02) and 90-day cash-flow projection (FR-RPT-05).
 */

export interface ProcurementSpendInput {
  tenantId: Types.ObjectId;
  rangeFrom: Date;
  rangeTo: Date;
  groupBy?: 'month' | 'supplier' | 'category';
  currency?: 'BDT' | 'USD';
}

export interface ProcurementSpendRow {
  bucket: string;
  supplierId: Types.ObjectId | null;
  supplierName: string | null;
  categoryId: Types.ObjectId | null;
  poCount: number;
  unitsOrdered: number;
  totalSpend: number;
}

/**
 * Total procurement spend rolled up by month / supplier / category for
 * a date range. Drill-through is supported by the caller passing a
 * different `groupBy`; the structure of the output rows is the same.
 *
 * Includes only POs that have transitioned past Approved (i.e. the buyer
 * has committed to the spend); Cancelled and Rejected POs are excluded.
 */
export async function procurementSpend(
  input: ProcurementSpendInput,
): Promise<ProcurementSpendRow[]> {
  const groupBy = input.groupBy ?? 'month';

  const bucketExpr =
    groupBy === 'month'
      ? { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'Asia/Dhaka' } }
      : groupBy === 'supplier'
        ? { $toString: '$supplierId' }
        : { $toString: { $ifNull: ['$lines.itemSnapshot.categoryId', '$_id'] } };

  const pipeline: PipelineStage[] = [
    {
      $match: {
        tenantId: input.tenantId,
        createdAt: { $gte: input.rangeFrom, $lte: input.rangeTo },
        state: { $in: ['approved', 'sent', 'partially_received', 'fully_received', 'closed'] },
        ...(input.currency ? { currency: input.currency } : {}),
      },
    },
    { $unwind: '$lines' },
    {
      $group: {
        _id: bucketExpr,
        supplierId: { $first: '$supplierId' },
        supplierName: { $first: '$supplierSnapshot.legalName' },
        poCount: { $addToSet: '$_id' },
        unitsOrdered: { $sum: '$lines.quantityOrdered' },
        totalSpend: { $sum: '$lines.lineTotal' },
      },
    },
    {
      $project: {
        _id: 0,
        bucket: '$_id',
        supplierId: groupBy === 'supplier' ? '$supplierId' : null,
        supplierName: groupBy === 'supplier' ? '$supplierName' : null,
        categoryId: null,
        poCount: { $size: '$poCount' },
        unitsOrdered: 1,
        totalSpend: 1,
      },
    },
    { $sort: { bucket: 1 } },
  ];

  return PurchaseOrder.aggregate<ProcurementSpendRow>(pipeline).exec();
}

export interface CashFlowProjectionInput {
  tenantId: Types.ObjectId;
  horizonDays?: number;
}

export interface CashFlowDay {
  date: string;
  payable: number;
  poCount: number;
  pos: { id: Types.ObjectId; number: string; supplierName: string; total: number }[];
}

/**
 * Forward-looking cash-flow projection (FR-RPT-05). For every PO in a
 * non-terminal post-Approved state, the projected payment date is
 * `expectedDeliveryAt + paymentTermsDays`. The output is bucketed by
 * day for the next 90 days (configurable).
 */
export async function cashFlowProjection(
  input: CashFlowProjectionInput,
): Promise<CashFlowDay[]> {
  const horizonDays = input.horizonDays ?? 90;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const horizonEnd = new Date(today.getTime() + horizonDays * 24 * 60 * 60 * 1000);

  const pipeline: PipelineStage[] = [
    {
      $match: {
        tenantId: input.tenantId,
        state: { $in: ['approved', 'sent', 'partially_received'] },
        expectedDeliveryAt: { $lte: horizonEnd },
      },
    },
    {
      $addFields: {
        projectedPayAt: {
          $dateAdd: {
            startDate: '$expectedDeliveryAt',
            unit: 'day',
            amount: '$paymentTermsDays',
          },
        },
      },
    },
    { $match: { projectedPayAt: { $gte: today, $lte: horizonEnd } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$projectedPayAt', timezone: 'Asia/Dhaka' } },
        payable: { $sum: '$totals.total' },
        poCount: { $sum: 1 },
        pos: {
          $push: {
            id: '$_id',
            number: '$number',
            supplierName: '$supplierSnapshot.legalName',
            total: '$totals.total',
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        date: '$_id',
        payable: 1,
        poCount: 1,
        pos: 1,
      },
    },
    { $sort: { date: 1 } },
  ];

  return PurchaseOrder.aggregate<CashFlowDay>(pipeline).exec();
}
