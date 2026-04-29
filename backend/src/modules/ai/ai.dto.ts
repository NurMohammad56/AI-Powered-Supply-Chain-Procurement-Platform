import { z } from 'zod';

import { objectIdStringSchema } from '../../shared/utils/objectId.js';
import { cursorQuerySchema } from '../../shared/utils/pagination.js';
import { FORECAST_HORIZONS } from './models/forecast.model.js';

export const GenerateForecastRequestSchema = z.object({
  itemId: objectIdStringSchema,
  horizonDays: z.union(
    FORECAST_HORIZONS.map((h) => z.literal(h)) as unknown as [
      z.ZodLiteral<number>,
      z.ZodLiteral<number>,
      ...z.ZodLiteral<number>[],
    ],
  ),
});
export type GenerateForecastRequest = z.infer<typeof GenerateForecastRequestSchema>;

export const ListForecastsQuerySchema = cursorQuerySchema.extend({
  itemId: objectIdStringSchema.optional(),
  horizonDays: z
    .enum(['7', '14', '30', '60', '90'])
    .optional()
    .transform((v) => (v === undefined ? undefined : Number(v))),
});
export type ListForecastsQuery = z.infer<typeof ListForecastsQuerySchema>;

export const ForecastIdParamSchema = z.object({
  id: objectIdStringSchema,
});
export type ForecastIdParam = z.infer<typeof ForecastIdParamSchema>;

export const OverrideForecastRequestSchema = z.object({
  quantity: z.number().min(0),
  justification: z.string().min(1).max(1000),
});
export type OverrideForecastRequest = z.infer<typeof OverrideForecastRequestSchema>;

export const BatchForecastRequestSchema = z.object({
  itemIds: z.array(objectIdStringSchema).max(2000).optional(),
});
export type BatchForecastRequest = z.infer<typeof BatchForecastRequestSchema>;

export interface ForecastView {
  id: string;
  itemId: string;
  horizonDays: number;
  predictedQuantity: number;
  predictedRange: { lower: number; upper: number };
  confidence: string;
  reasoning: string;
  seasonalityDetected: boolean;
  reorderPointSuggestion: {
    quantity: number;
    safetyStockFactor: number;
    leadTimeDaysAssumed: number;
  } | null;
  override: {
    by: string;
    at: string;
    quantity: number;
    justification: string;
  } | null;
  provenance: {
    provider: string;
    model: string;
    promptVersion: string;
    failoverInvoked: boolean;
    latencyMs: number;
    cacheHit: boolean;
  };
  generatedAt: string;
  expiresAt: string;
  actualQuantity: number | null;
  mape: number | null;
}
