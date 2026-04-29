import { z } from 'zod';

import type { ConsumptionFeatures } from '../dataPreparation.js';

const nonNegInt = z
  .number()
  .finite()
  .transform((n) => Math.max(0, Math.round(n)));

const nonNegFloat = z
  .number()
  .finite()
  .transform((n) => Math.max(0, n));

const rangeSchema = z
  .object({
    lower: nonNegInt,
    upper: nonNegInt,
  })
  .refine((v) => v.lower <= v.upper, 'lower must be <= upper');

const reorderSchema = z
  .object({
    quantity: nonNegInt,
    safetyStockFactor: z.number().finite().min(0).max(5).default(1.65),
    leadTimeDaysAssumed: z.number().int().min(0).max(365).default(14),
  })
  .nullable();

/**
 * Strict schema: what we expect from a well-behaved LLM. The pipeline
 * runs this against the parsed JSON; anything that fails is funneled
 * into `coerceForecast` for graceful degradation.
 */
export const StrictForecastResponseSchema = z.object({
  predictedQuantity30Day: nonNegInt,
  predictedQuantity60Day: nonNegInt,
  predictedQuantity90Day: nonNegInt,
  predictedRange30Day: rangeSchema,
  predictedRange60Day: rangeSchema,
  predictedRange90Day: rangeSchema,
  confidence: z.enum(['low', 'medium', 'high']),
  reasoning: z.string().min(1).max(4000),
  seasonalityDetected: z.boolean(),
  seasonalityNote: z.string().max(500).nullable(),
  reorderPointSuggestion: reorderSchema,
  anomalies: z.array(z.string().max(300)).max(20),
});
export type StrictForecastResponse = z.infer<typeof StrictForecastResponseSchema>;

/**
 * Lenient schema: accepts partial / loose responses. Used as a second
 * pass when the strict parse fails. Anything still invalid falls
 * through to a deterministic baseline derived from the input features.
 */
const LenientForecastResponseSchema = z.object({
  predictedQuantity30Day: nonNegFloat.optional(),
  predictedQuantity60Day: nonNegFloat.optional(),
  predictedQuantity90Day: nonNegFloat.optional(),
  predictedRange30Day: z
    .object({ lower: nonNegFloat.optional(), upper: nonNegFloat.optional() })
    .optional(),
  predictedRange60Day: z
    .object({ lower: nonNegFloat.optional(), upper: nonNegFloat.optional() })
    .optional(),
  predictedRange90Day: z
    .object({ lower: nonNegFloat.optional(), upper: nonNegFloat.optional() })
    .optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  reasoning: z.string().optional(),
  seasonalityDetected: z.boolean().optional(),
  seasonalityNote: z.string().nullable().optional(),
  reorderPointSuggestion: z
    .object({
      quantity: nonNegFloat.optional(),
      safetyStockFactor: z.number().optional(),
      leadTimeDaysAssumed: z.number().optional(),
    })
    .nullable()
    .optional(),
  anomalies: z.array(z.string()).optional(),
});

export interface CoerceArgs {
  /** Features from data prep - used to derive a deterministic baseline. */
  features: ConsumptionFeatures;
  /** Lead time used for the reorder-point fallback. */
  leadTimeDays: number;
  /** Raw model output - may be JSON or partial nonsense. */
  rawJson: unknown;
}

/**
 * Validate the model output, repairing it when possible. Always returns
 * a usable response object; never throws.
 *
 * Repair order:
 *   1. Strict parse - if it passes, ship as-is.
 *   2. Lenient parse + per-field coercion + range monotonicity fixes.
 *   3. Total fallback to a deterministic baseline so the API never 500s.
 */
export function coerceForecast(args: CoerceArgs): {
  response: StrictForecastResponse;
  coerced: boolean;
  fallback: boolean;
} {
  const strictParse = StrictForecastResponseSchema.safeParse(args.rawJson);
  if (strictParse.success) {
    return {
      response: enforceMonotonicHorizons(strictParse.data),
      coerced: false,
      fallback: false,
    };
  }
  const lenientParse = LenientForecastResponseSchema.safeParse(args.rawJson);
  if (lenientParse.success) {
    return {
      response: repairFromLenient(lenientParse.data, args),
      coerced: true,
      fallback: false,
    };
  }
  return {
    response: deterministicBaseline(args),
    coerced: true,
    fallback: true,
  };
}

function repairFromLenient(
  parsed: z.infer<typeof LenientForecastResponseSchema>,
  args: CoerceArgs,
): StrictForecastResponse {
  const baseline = deterministicBaseline(args);
  const r30 = repairRange(parsed.predictedRange30Day, baseline.predictedRange30Day);
  const r60 = repairRange(parsed.predictedRange60Day, baseline.predictedRange60Day);
  const r90 = repairRange(parsed.predictedRange90Day, baseline.predictedRange90Day);
  const candidate: StrictForecastResponse = {
    predictedQuantity30Day: roundOr(parsed.predictedQuantity30Day, baseline.predictedQuantity30Day),
    predictedQuantity60Day: roundOr(parsed.predictedQuantity60Day, baseline.predictedQuantity60Day),
    predictedQuantity90Day: roundOr(parsed.predictedQuantity90Day, baseline.predictedQuantity90Day),
    predictedRange30Day: r30,
    predictedRange60Day: r60,
    predictedRange90Day: r90,
    confidence: parsed.confidence ?? baseline.confidence,
    reasoning: parsed.reasoning?.slice(0, 4000) ?? baseline.reasoning,
    seasonalityDetected: parsed.seasonalityDetected ?? baseline.seasonalityDetected,
    seasonalityNote: parsed.seasonalityNote ?? baseline.seasonalityNote,
    reorderPointSuggestion: parsed.reorderPointSuggestion
      ? {
          quantity: roundOr(parsed.reorderPointSuggestion.quantity, baseline.reorderPointSuggestion?.quantity ?? 0),
          safetyStockFactor:
            parsed.reorderPointSuggestion.safetyStockFactor ??
            baseline.reorderPointSuggestion?.safetyStockFactor ??
            1.65,
          leadTimeDaysAssumed:
            parsed.reorderPointSuggestion.leadTimeDaysAssumed ??
            baseline.reorderPointSuggestion?.leadTimeDaysAssumed ??
            args.leadTimeDays,
        }
      : baseline.reorderPointSuggestion,
    anomalies: (parsed.anomalies ?? baseline.anomalies).map((s) => s.slice(0, 300)).slice(0, 20),
  };
  return enforceMonotonicHorizons(candidate);
}

function repairRange(
  raw: { lower?: number; upper?: number } | undefined,
  baseline: { lower: number; upper: number },
): { lower: number; upper: number } {
  if (!raw) return baseline;
  let lower = raw.lower !== undefined ? Math.max(0, Math.round(raw.lower)) : baseline.lower;
  let upper = raw.upper !== undefined ? Math.max(0, Math.round(raw.upper)) : baseline.upper;
  if (lower > upper) [lower, upper] = [upper, lower];
  return { lower, upper };
}

function enforceMonotonicHorizons(r: StrictForecastResponse): StrictForecastResponse {
  if (r.predictedQuantity60Day < r.predictedQuantity30Day) {
    r.predictedQuantity60Day = r.predictedQuantity30Day;
  }
  if (r.predictedQuantity90Day < r.predictedQuantity60Day) {
    r.predictedQuantity90Day = r.predictedQuantity60Day;
  }
  return r;
}

function roundOr(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.round(value));
}

/**
 * Deterministic baseline derived purely from the input features. Used
 * when both LLMs return garbage, so the API still returns a usable
 * (clearly-low-confidence) forecast instead of a hard error.
 */
export function deterministicBaseline(args: CoerceArgs): StrictForecastResponse {
  const f = args.features;
  const avg = f.averageDailyConsumption;
  const sd = f.stdDeviation;
  const q30 = Math.max(0, Math.round(avg * 30));
  const q60 = Math.max(q30, Math.round(avg * 60));
  const q90 = Math.max(q60, Math.round(avg * 90));
  const widen = f.coefficientOfVariation > 0.5 ? 0.5 : 0.25;
  const range = (q: number): { lower: number; upper: number } => ({
    lower: Math.max(0, Math.round(q * (1 - widen))),
    upper: Math.max(0, Math.round(q * (1 + widen))),
  });
  const safetyFactor = f.coefficientOfVariation > 1 ? 2.0 : 1.65;
  const reorderQuantity =
    Math.round(avg * args.leadTimeDays + safetyFactor * sd * Math.sqrt(Math.max(1, args.leadTimeDays)));
  const reasoning =
    f.dataSparsity === 'empty'
      ? 'No consumption history available; baseline returns zero with low confidence. The procurement manager should review historical paper records or run a small trial order to seed the model.'
      : `Deterministic fallback used because the LLM response could not be parsed. Forecast extrapolates the historical mean (${avg.toFixed(2)} units/day) over each horizon and widens the interval based on the observed coefficient of variation (${f.coefficientOfVariation.toFixed(2)}). Confidence is low - re-run after the AI pipeline recovers.`;
  return {
    predictedQuantity30Day: q30,
    predictedQuantity60Day: q60,
    predictedQuantity90Day: q90,
    predictedRange30Day: range(q30),
    predictedRange60Day: range(q60),
    predictedRange90Day: range(q90),
    confidence: 'low',
    reasoning,
    seasonalityDetected: f.seasonalityDetected,
    seasonalityNote: f.seasonalityDetected
      ? `Autocorrelation score ${f.seasonalityScore.toFixed(2)} suggests a periodic pattern in the historical data.`
      : null,
    reorderPointSuggestion:
      f.dataSparsity === 'empty'
        ? null
        : {
            quantity: reorderQuantity,
            safetyStockFactor: safetyFactor,
            leadTimeDaysAssumed: args.leadTimeDays,
          },
    anomalies:
      f.dataSparsity === 'empty'
        ? ['Empty consumption history.']
        : ['LLM output was not usable; deterministic baseline applied.'],
  };
}

/** Strip code fences, leading/trailing prose, and parse JSON. */
export function extractJsonObject(text: string): unknown {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  // Locate the outermost JSON object braces if the model added
  // surrounding prose despite the instruction.
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('No JSON object found in model response');
  }
  const jsonSlice = cleaned.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonSlice) as unknown;
}
