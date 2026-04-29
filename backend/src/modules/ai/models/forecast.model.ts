import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';

export type ForecastHorizonDays = 7 | 14 | 30 | 60 | 90;
export const FORECAST_HORIZONS: readonly ForecastHorizonDays[] = [7, 14, 30, 60, 90] as const;

export type ForecastConfidence = 'low' | 'medium' | 'high';

export interface ForecastInputPoint {
  periodStart: Date;
  periodEnd: Date;
  consumed: number;
}

export interface ForecastReorderSuggestion {
  quantity: number;
  safetyStockFactor: number;
  leadTimeDaysAssumed: number;
}

export interface ForecastOverride {
  by: Types.ObjectId;
  at: Date;
  quantity: number;
  justification: string;
}

export type AiProvider = 'groq' | 'gemini';

export interface ForecastProvenance {
  provider: AiProvider;
  model: string;
  promptVersion: string;
  failoverInvoked: boolean;
  latencyMs: number;
  cacheHit: boolean;
  promptTokens: number;
  completionTokens: number;
}

export interface ForecastDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  itemId: Types.ObjectId;
  horizonDays: ForecastHorizonDays;
  predictedQuantity: number;
  predictedRange: { lower: number; upper: number };
  confidence: ForecastConfidence;
  reasoning: string;
  seasonalityDetected: boolean;
  inputSeries: ForecastInputPoint[];
  reorderPointSuggestion: ForecastReorderSuggestion | null;
  override: ForecastOverride | null;
  provenance: ForecastProvenance;
  rawPrompt: string | null;
  rawResponse: string | null;
  generatedAt: Date;
  expiresAt: Date;
  actualQuantity: number | null;
  mape: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ForecastHydrated = HydratedDocument<ForecastDoc>;

const inputPointSchema = new Schema<ForecastInputPoint>(
  {
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    consumed: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const reorderSuggestionSchema = new Schema<ForecastReorderSuggestion>(
  {
    quantity: { type: Number, required: true, min: 0 },
    safetyStockFactor: { type: Number, required: true, min: 0 },
    leadTimeDaysAssumed: { type: Number, required: true, min: 0, max: 365 },
  },
  { _id: false },
);

const overrideSchema = new Schema<ForecastOverride>(
  {
    by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    at: { type: Date, required: true, default: () => new Date() },
    quantity: { type: Number, required: true, min: 0 },
    justification: { type: String, required: true, trim: true, maxlength: 1000 },
  },
  { _id: false },
);

const provenanceSchema = new Schema<ForecastProvenance>(
  {
    provider: { type: String, enum: ['groq', 'gemini'], required: true },
    model: { type: String, required: true, trim: true, maxlength: 80 },
    promptVersion: { type: String, required: true, trim: true, maxlength: 40 },
    failoverInvoked: { type: Boolean, default: false },
    latencyMs: { type: Number, default: 0, min: 0 },
    cacheHit: { type: Boolean, default: false },
    promptTokens: { type: Number, default: 0, min: 0 },
    completionTokens: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const forecastSchema = new Schema<ForecastDoc>(
  {
    itemId: { type: Schema.Types.ObjectId, ref: 'Item', required: true },
    horizonDays: { type: Number, enum: FORECAST_HORIZONS, required: true },
    predictedQuantity: { type: Number, required: true, min: 0 },
    predictedRange: {
      lower: { type: Number, required: true, min: 0 },
      upper: { type: Number, required: true, min: 0 },
    },
    confidence: { type: String, enum: ['low', 'medium', 'high'], required: true },
    reasoning: { type: String, required: true, trim: true, maxlength: 4000 },
    seasonalityDetected: { type: Boolean, default: false },
    inputSeries: { type: [inputPointSchema], default: [] },
    reorderPointSuggestion: { type: reorderSuggestionSchema, default: null },
    override: { type: overrideSchema, default: null },
    provenance: { type: provenanceSchema, required: true },
    rawPrompt: { type: String, default: null, maxlength: 32_000 },
    rawResponse: { type: String, default: null, maxlength: 32_000 },
    generatedAt: { type: Date, required: true, default: () => new Date() },
    expiresAt: { type: Date, required: true },
    actualQuantity: { type: Number, default: null, min: 0 },
    mape: { type: Number, default: null, min: 0 },
  },
  { timestamps: true },
);

forecastSchema.index({ tenantId: 1, itemId: 1, horizonDays: 1, generatedAt: -1 });
forecastSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
forecastSchema.index({ tenantId: 1, mape: -1 }, { partialFilterExpression: { mape: { $type: 'number' } } });

forecastSchema.plugin(tenancyPlugin);
forecastSchema.plugin(auditPlugin);

export const Forecast = model<ForecastDoc>('Forecast', forecastSchema);
