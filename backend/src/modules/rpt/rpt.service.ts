import { Types } from 'mongoose';

import { BadRequestError, NotFoundError } from '../../shared/errors/HttpErrors.js';
import type { TenantContext } from '../../shared/auth/types.js';
import { Item } from '../inventory/models/item.model.js';
import { StockBalance } from '../inventory/models/stockBalance.model.js';
import { StockMovement } from '../inventory/models/stockMovement.model.js';
import { PurchaseOrder } from '../po/models/purchaseOrder.model.js';
import { Supplier } from '../supplier/models/supplier.model.js';
import { fetchMovementHistoryInRange, sumConsumed } from '../ai/dataPreparation.js';
import {
  cashFlowProjectionPipeline,
  deadStockPipeline,
  inventoryTurnoverByCategoryPipeline,
  spendBySupplierPipeline,
  supplierCostComparisonPipeline,
} from './rpt.aggregations.js';
import { ProcurementBudget } from './models/procurementBudget.model.js';
import type {
  AbcAnalysisItemView,
  AbcAnalysisView,
  BudgetStatusView,
  EoqView,
  UpsertBudgetRequest,
  UpsertBudgetView,
  ReportRangeQuery,
} from './rpt.dto.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_ABC_WINDOW_DAYS = 365;

export class RptService {
  async inventoryTurnover(ctx: TenantContext, q: ReportRangeQuery) {
    return runInventoryTurnover({
      tenantId: ctx.tenantId,
      from: new Date(q.from),
      to: new Date(q.to),
    });
  }

  async spendBySupplier(ctx: TenantContext, q: ReportRangeQuery) {
    return runSpendBySupplier({
      tenantId: ctx.tenantId,
      from: new Date(q.from),
      to: new Date(q.to),
    });
  }

  async supplierCostComparison(ctx: TenantContext, q: ReportRangeQuery) {
    return runSupplierCostComparison({
      tenantId: ctx.tenantId,
      from: new Date(q.from),
      to: new Date(q.to),
    });
  }

  async cashFlowProjection(ctx: TenantContext) {
    return runCashFlowProjection({ tenantId: ctx.tenantId });
  }

  async deadStock(ctx: TenantContext, q: ReportRangeQuery) {
    return runDeadStock({
      tenantId: ctx.tenantId,
      from: new Date(q.from),
      to: new Date(q.to),
    });
  }

  async abcAnalysis(
    ctx: TenantContext,
    q: { from?: string; to?: string },
  ): Promise<AbcAnalysisView> {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - DEFAULT_ABC_WINDOW_DAYS * MS_PER_DAY);
    const movements = await StockMovement.find({
      tenantId: ctx.tenantId,
      performedAt: { $gte: from, $lt: to },
      type: { $in: ['out', 'transfer_out', 'adjustment'] },
    })
      .select({ itemId: 1, quantity: 1, type: 1 })
      .lean<Array<{ itemId: Types.ObjectId; quantity: number; type: string }>>()
      .exec();

    const movementTotals = new Map<string, number>();
    for (const movement of movements) {
      const key = movement.itemId.toString();
      let consumed = 0;
      if (movement.type === 'out' || movement.type === 'transfer_out') {
        consumed = movement.quantity < 0 ? -movement.quantity : movement.quantity;
      } else if (movement.type === 'adjustment' && movement.quantity < 0) {
        consumed = -movement.quantity;
      }
      if (consumed > 0) {
        movementTotals.set(key, (movementTotals.get(key) ?? 0) + consumed);
      }
    }

    const itemIds = [...movementTotals.keys()].map((id) => new Types.ObjectId(id));
    const itemsById = new Map(
      (
        await Item.find({ tenantId: ctx.tenantId, _id: { $in: itemIds } })
          .select({ sku: 1, name: 1, type: 1, categoryId: 1, movingAverageCost: 1 })
          .lean()
          .exec()
      ).map((item) => [item._id.toString(), item]),
    );

    const rawRows = [...movementTotals.entries()]
      .map(([itemId, quantityConsumed]) => {
        const item = itemsById.get(itemId);
        if (!item) return null;
        return {
          itemId: new Types.ObjectId(itemId),
          sku: item.sku,
          name: item.name,
          type: item.type,
          categoryId: item.categoryId,
          quantityConsumed,
          movingAverageCost: item.movingAverageCost,
          consumptionValue: quantityConsumed * item.movingAverageCost,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => b.consumptionValue - a.consumptionValue);

    const totalConsumptionValue = rawRows.reduce((sum, row) => sum + Number(row.consumptionValue ?? 0), 0);
    let cumulative = 0;
    const items = rawRows.map((row): AbcAnalysisItemView => {
      const consumptionValue = Number(row.consumptionValue ?? 0);
      const sharePct = totalConsumptionValue > 0 ? (consumptionValue / totalConsumptionValue) * 100 : 0;
      cumulative += sharePct;
      const classification = cumulative <= 80 ? 'A' : cumulative <= 95 ? 'B' : 'C';
      return {
        itemId: row.itemId.toString(),
        sku: String(row.sku ?? ''),
        name: String(row.name ?? ''),
        type: String(row.type ?? ''),
        categoryId: row.categoryId ? row.categoryId.toString() : null,
        quantityConsumed: Number(row.quantityConsumed ?? 0),
        consumptionValue,
        sharePct: round2(sharePct),
        cumulativePct: round2(cumulative),
        classification,
      };
    });

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totalConsumptionValue: round2(totalConsumptionValue),
      items,
    };
  }

  async eoq(
    ctx: TenantContext,
    q: { itemId: string; orderingCost: number; holdingCostRate: number; leadTimeDays?: number },
  ): Promise<EoqView> {
    const item = await Item.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(q.itemId), archivedAt: null })
      .lean()
      .exec();
    if (!item) throw new NotFoundError();

    const supplierLeadTimeDays = item.preferredSupplierId
      ? await Supplier.findOne({ tenantId: ctx.tenantId, _id: item.preferredSupplierId })
          .select({ leadTimeDays: 1 })
          .lean()
          .then((s) => s?.leadTimeDays)
      : undefined;
    const leadTimeDays = q.leadTimeDays ?? supplierLeadTimeDays ?? 14;

    const from = new Date(Date.now() - 365 * MS_PER_DAY);
    const to = new Date();
    const movements = await fetchMovementHistoryInRange({
      tenantId: ctx.tenantId,
      itemId: item._id,
      from,
      to,
    });
    const annualDemand = sumConsumed(movements);
    const averageDailyDemand = annualDemand / 365;
    const holdingCostPerUnitPerYear = item.movingAverageCost * q.holdingCostRate;
    const eoqValue =
      annualDemand > 0 && holdingCostPerUnitPerYear > 0
        ? Math.sqrt((2 * annualDemand * q.orderingCost) / holdingCostPerUnitPerYear)
        : 0;
    const reorderPoint = Math.max(0, Math.round(averageDailyDemand * leadTimeDays));
    const currentStock = await StockBalance.aggregate([
      { $match: { tenantId: ctx.tenantId, itemId: item._id } },
      { $group: { _id: null, quantity: { $sum: '$quantity' } } },
    ]).exec();

    return {
      itemId: item._id.toString(),
      sku: item.sku,
      name: item.name,
      annualDemand: round2(annualDemand),
      orderingCost: q.orderingCost,
      holdingCostPerUnitPerYear: round2(holdingCostPerUnitPerYear),
      holdingCostRate: q.holdingCostRate,
      eoq: round2(eoqValue),
      recommendedOrderQuantity: Math.max(0, Math.round(eoqValue)),
      leadTimeDays,
      averageDailyDemand: round2(averageDailyDemand),
      reorderPoint,
      currentStock: typeof currentStock[0]?.quantity === 'number' ? currentStock[0].quantity : null,
    };
  }

  async getBudgetStatus(ctx: TenantContext, q?: { monthStart?: string }): Promise<BudgetStatusView> {
    const monthStart = q?.monthStart ? startOfMonthUtc(new Date(q.monthStart)) : startOfMonthUtc(new Date());
    const budget = await ProcurementBudget.findOne({ tenantId: ctx.tenantId, monthStart }).lean().exec();
    const monthEnd = nextMonthStartUtc(monthStart);
    const currency = budget?.currency ?? 'BDT';
    const committed = await this.sumPurchaseOrderSpend(ctx.tenantId, monthStart, monthEnd, currency);
    const daysElapsed = Math.max(1, Math.ceil((Date.now() - monthStart.getTime()) / MS_PER_DAY));
    const daysInMonth = Math.max(1, Math.ceil((monthEnd.getTime() - monthStart.getTime()) / MS_PER_DAY));
    const projectedMonthEnd = round2((committed / daysElapsed) * daysInMonth);

    if (!budget) {
      return {
        monthStart: monthStart.toISOString(),
        currency,
        budget: null,
        spend: {
          committed: round2(committed),
          projectedMonthEnd,
          remaining: null,
          utilizationPct: null,
          status: 'no_budget',
        },
      };
    }

    const remaining = round2(budget.monthlyLimit - committed);
    const utilizationPct = budget.monthlyLimit > 0 ? round2((committed / budget.monthlyLimit) * 100) : null;
    const status =
      budget.monthlyLimit === 0
        ? 'overrun'
        : committed >= budget.monthlyLimit
        ? 'overrun'
        : utilizationPct !== null && utilizationPct >= budget.warningThresholdPct
        ? 'warning'
        : 'ok';

    return {
      monthStart: monthStart.toISOString(),
      currency,
      budget: {
        monthlyLimit: budget.monthlyLimit,
        warningThresholdPct: budget.warningThresholdPct,
        notes: budget.notes,
      },
      spend: {
        committed: round2(committed),
        projectedMonthEnd,
        remaining,
        utilizationPct,
        status,
      },
    };
  }

  async upsertBudget(ctx: TenantContext, input: UpsertBudgetRequest): Promise<UpsertBudgetView> {
    const monthStart = input.monthStart ? startOfMonthUtc(new Date(input.monthStart)) : startOfMonthUtc(new Date());
    const updated = await ProcurementBudget.findOneAndUpdate(
      { tenantId: ctx.tenantId, monthStart },
      {
        $set: {
          currency: input.currency,
          monthlyLimit: input.monthlyLimit,
          warningThresholdPct: input.warningThresholdPct,
          notes: input.notes ?? null,
          updatedBy: ctx.userId,
        },
        $setOnInsert: {
          createdBy: ctx.userId,
        },
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    )
      .lean()
      .exec();

    if (!updated) throw new BadRequestError('BUDGET_UPSERT_FAILED', 'Could not save budget');

    return {
      monthStart: updated.monthStart.toISOString(),
      currency: updated.currency,
      monthlyLimit: updated.monthlyLimit,
      warningThresholdPct: updated.warningThresholdPct,
      notes: updated.notes,
    };
  }

  private async sumPurchaseOrderSpend(
    tenantId: Types.ObjectId,
    from: Date,
    to: Date,
    currency: 'BDT' | 'USD',
  ): Promise<number> {
    const rows = await PurchaseOrder.aggregate([
      {
        $match: {
          tenantId,
          createdAt: { $gte: from, $lt: to },
          state: { $in: ['approved', 'sent', 'partially_received', 'fully_received', 'closed'] },
          currency,
        },
      },
      {
        $group: {
          _id: null,
          committed: { $sum: '$totals.total' },
        },
      },
    ]).exec();
    return Number(rows[0]?.committed ?? 0);
  }
}

async function runInventoryTurnover(args: { tenantId: Types.ObjectId; from: Date; to: Date }): Promise<unknown[]> {
  return StockMovement.aggregate(inventoryTurnoverByCategoryPipeline(args)).exec();
}

async function runSpendBySupplier(args: { tenantId: Types.ObjectId; from: Date; to: Date }): Promise<unknown[]> {
  return PurchaseOrder.aggregate(spendBySupplierPipeline(args)).exec();
}

async function runSupplierCostComparison(args: {
  tenantId: Types.ObjectId;
  from: Date;
  to: Date;
}): Promise<unknown[]> {
  return PurchaseOrder.aggregate(supplierCostComparisonPipeline(args)).exec();
}

async function runCashFlowProjection(args: { tenantId: Types.ObjectId }): Promise<unknown[]> {
  return PurchaseOrder.aggregate(cashFlowProjectionPipeline(args)).exec();
}

async function runDeadStock(args: { tenantId: Types.ObjectId; from: Date; to: Date }): Promise<unknown[]> {
  return StockBalance.aggregate(deadStockPipeline(args)).exec();
}

function startOfMonthUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function nextMonthStartUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export const rptService = new RptService();
