import { z } from 'zod';

import { objectIdStringSchema } from '../../shared/utils/objectId.js';

export const ReportRangeQuerySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});
export type ReportRangeQuery = z.infer<typeof ReportRangeQuerySchema>;

export const AbcAnalysisQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type AbcAnalysisQuery = z.infer<typeof AbcAnalysisQuerySchema>;

export const EoqQuerySchema = z.object({
  itemId: objectIdStringSchema,
  orderingCost: z.coerce.number().positive().default(500),
  holdingCostRate: z.coerce.number().positive().max(1).default(0.2),
  leadTimeDays: z.coerce.number().int().min(1).max(365).optional(),
});
export type EoqQuery = z.infer<typeof EoqQuerySchema>;

export const UpsertBudgetRequestSchema = z.object({
  monthStart: z.string().datetime().optional(),
  currency: z.enum(['BDT', 'USD']).default('BDT'),
  monthlyLimit: z.coerce.number().positive(),
  warningThresholdPct: z.coerce.number().min(0).max(100).default(80),
  notes: z.string().max(1000).optional().nullable(),
});
export type UpsertBudgetRequest = z.infer<typeof UpsertBudgetRequestSchema>;

export interface AbcAnalysisItemView {
  itemId: string;
  sku: string;
  name: string;
  type: string;
  categoryId: string | null;
  quantityConsumed: number;
  consumptionValue: number;
  sharePct: number;
  cumulativePct: number;
  classification: 'A' | 'B' | 'C';
}

export interface AbcAnalysisView {
  from: string;
  to: string;
  totalConsumptionValue: number;
  items: AbcAnalysisItemView[];
}

export interface EoqView {
  itemId: string;
  sku: string;
  name: string;
  annualDemand: number;
  orderingCost: number;
  holdingCostPerUnitPerYear: number;
  holdingCostRate: number;
  eoq: number;
  recommendedOrderQuantity: number;
  leadTimeDays: number;
  averageDailyDemand: number;
  reorderPoint: number;
  currentStock: number | null;
}

export interface BudgetStatusView {
  monthStart: string;
  currency: string;
  budget: {
    monthlyLimit: number;
    warningThresholdPct: number;
    notes: string | null;
  } | null;
  spend: {
    committed: number;
    projectedMonthEnd: number;
    remaining: number | null;
    utilizationPct: number | null;
    status: 'no_budget' | 'ok' | 'warning' | 'overrun';
  };
}

export interface UpsertBudgetView {
  monthStart: string;
  currency: string;
  monthlyLimit: number;
  warningThresholdPct: number;
  notes: string | null;
}
