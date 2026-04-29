import { Types } from 'mongoose';

import { Item, type ItemDoc } from '../inventory/models/item.model.js';
import { StockMovement } from '../inventory/models/stockMovement.model.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface DailyConsumptionPoint {
  date: string; // YYYY-MM-DD
  consumed: number; // units consumed (positive number)
}

export interface MonthlyConsumptionPoint {
  month: string; // YYYY-MM
  consumed: number;
  movementCount: number;
}

export interface ConsumptionFeatures {
  windowDays: number;
  totalConsumed: number;
  averageDailyConsumption: number;
  medianDailyConsumption: number;
  stdDeviation: number;
  coefficientOfVariation: number;
  trendSlopeUnitsPerDay: number;
  trendDirection: 'increasing' | 'decreasing' | 'flat';
  seasonalityScore: number;
  seasonalityDetected: boolean;
  zeroConsumptionDays: number;
  peakDayConsumed: number;
  peakDayDate: string | null;
  recencyBiasScore: number; // ratio of last-30-days vs prior period
  dataSparsity: 'rich' | 'moderate' | 'sparse' | 'empty';
}

export interface ItemContext {
  id: string;
  sku: string;
  name: string;
  unit: string;
  type: string;
  reorderLevel: number;
  movingAverageCost: number;
  preferredSupplierLeadTimeDays: number | null;
}

export interface ForecastContext {
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  item: ItemContext;
  features: ConsumptionFeatures;
  dailySeries: DailyConsumptionPoint[];
  monthlySeries: MonthlyConsumptionPoint[];
}

interface MovementRow {
  performedAt: Date;
  type: string;
  quantity: number;
}

/** Fetch the last `windowDays` of stock movements for a tenant+item. */
export async function fetchMovementHistory(args: {
  tenantId: Types.ObjectId;
  itemId: Types.ObjectId;
  windowDays: number;
}): Promise<MovementRow[]> {
  const since = new Date(Date.now() - args.windowDays * MS_PER_DAY);
  return StockMovement.find({
    tenantId: args.tenantId,
    itemId: args.itemId,
    performedAt: { $gte: since },
    // Consumption-relevant types only: outflows + adjustments.
    type: { $in: ['out', 'transfer_out', 'adjustment'] },
  })
    .select({ performedAt: 1, type: 1, quantity: 1 })
    .sort({ performedAt: 1 })
    .lean<MovementRow[]>()
    .exec();
}

/**
 * Convert raw signed-quantity movements into a daily-consumption series.
 * Outflows contribute as positive consumption (`-quantity` for `out`/
 * `transfer_out`); negative adjustments contribute their absolute value.
 * Positive adjustments are ignored - they represent restocks, not
 * consumption.
 */
export function buildDailySeries(
  movements: MovementRow[],
  windowStart: Date,
  windowEnd: Date,
): DailyConsumptionPoint[] {
  const buckets = new Map<string, number>();

  // Pre-fill every day in the window so the LLM sees zero days explicitly.
  for (let t = windowStart.getTime(); t <= windowEnd.getTime(); t += MS_PER_DAY) {
    buckets.set(toIsoDate(new Date(t)), 0);
  }

  for (const m of movements) {
    const key = toIsoDate(m.performedAt);
    const existing = buckets.get(key) ?? 0;
    let consumed = 0;
    if (m.type === 'out' || m.type === 'transfer_out') {
      consumed = m.quantity < 0 ? -m.quantity : m.quantity;
    } else if (m.type === 'adjustment' && m.quantity < 0) {
      consumed = -m.quantity;
    }
    if (consumed > 0) buckets.set(key, existing + consumed);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, consumed]) => ({ date, consumed }));
}

/** Fold the daily series into month buckets for trend visualisation. */
export function buildMonthlySeries(daily: DailyConsumptionPoint[]): MonthlyConsumptionPoint[] {
  const buckets = new Map<string, { consumed: number; movementCount: number }>();
  for (const point of daily) {
    const key = point.date.slice(0, 7);
    const cur = buckets.get(key) ?? { consumed: 0, movementCount: 0 };
    cur.consumed += point.consumed;
    if (point.consumed > 0) cur.movementCount += 1;
    buckets.set(key, cur);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, v]) => ({ month, ...v }));
}

/**
 * Compute statistical features over the daily series. All values are
 * rounded to 4 decimal places to keep the prompt deterministic and the
 * LLM context small.
 */
export function computeFeatures(daily: DailyConsumptionPoint[]): ConsumptionFeatures {
  const windowDays = daily.length;
  if (windowDays === 0) {
    return emptyFeatures(0);
  }
  const consumptions = daily.map((d) => d.consumed);
  const totalConsumed = consumptions.reduce((sum, x) => sum + x, 0);
  const averageDailyConsumption = round4(totalConsumed / windowDays);
  const sorted = [...consumptions].sort((a, b) => a - b);
  const midPoint = Math.floor(sorted.length / 2);
  const medianDailyConsumption =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 0
      ? round4(((sorted[midPoint - 1] ?? 0) + (sorted[midPoint] ?? 0)) / 2)
      : round4(sorted[midPoint] ?? 0);
  const variance =
    consumptions.reduce((acc, x) => acc + (x - averageDailyConsumption) ** 2, 0) / windowDays;
  const stdDeviation = round4(Math.sqrt(variance));
  const coefficientOfVariation =
    averageDailyConsumption > 0 ? round4(stdDeviation / averageDailyConsumption) : 0;

  const trendSlopeUnitsPerDay = computeLinearTrendSlope(consumptions);
  const trendDirection: ConsumptionFeatures['trendDirection'] =
    Math.abs(trendSlopeUnitsPerDay) < 0.001
      ? 'flat'
      : trendSlopeUnitsPerDay > 0
      ? 'increasing'
      : 'decreasing';

  const zeroConsumptionDays = consumptions.filter((c) => c === 0).length;

  let peakDayConsumed = 0;
  let peakDayDate: string | null = null;
  for (const d of daily) {
    if (d.consumed > peakDayConsumed) {
      peakDayConsumed = d.consumed;
      peakDayDate = d.date;
    }
  }

  const seasonalityScore = computeSeasonalityScore(consumptions);
  const seasonalityDetected = seasonalityScore >= 0.25;

  const last30 = consumptions.slice(-30);
  const prior = consumptions.slice(0, Math.max(0, consumptions.length - 30));
  const last30Avg = last30.length > 0 ? last30.reduce((a, b) => a + b, 0) / last30.length : 0;
  const priorAvg = prior.length > 0 ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
  const recencyBiasScore = priorAvg === 0 ? (last30Avg > 0 ? 2 : 1) : round4(last30Avg / priorAvg);

  let dataSparsity: ConsumptionFeatures['dataSparsity'] = 'empty';
  if (totalConsumed > 0) {
    const nonZeroRatio = (windowDays - zeroConsumptionDays) / windowDays;
    if (nonZeroRatio >= 0.5) dataSparsity = 'rich';
    else if (nonZeroRatio >= 0.2) dataSparsity = 'moderate';
    else dataSparsity = 'sparse';
  }

  return {
    windowDays,
    totalConsumed: round4(totalConsumed),
    averageDailyConsumption,
    medianDailyConsumption,
    stdDeviation,
    coefficientOfVariation,
    trendSlopeUnitsPerDay: round4(trendSlopeUnitsPerDay),
    trendDirection,
    seasonalityScore: round4(seasonalityScore),
    seasonalityDetected,
    zeroConsumptionDays,
    peakDayConsumed: round4(peakDayConsumed),
    peakDayDate,
    recencyBiasScore,
    dataSparsity,
  };
}

/**
 * Build the complete forecast context. This is the only function the
 * pipeline calls into - it owns the entire data-prep contract.
 */
export async function prepareForecastContext(args: {
  tenantId: Types.ObjectId;
  item: ItemDoc;
  windowDays?: number;
  preferredSupplierLeadTimeDays?: number | null;
}): Promise<ForecastContext> {
  const windowDays = args.windowDays ?? 180;
  const windowEnd = startOfUtcDay(new Date());
  const windowStart = new Date(windowEnd.getTime() - (windowDays - 1) * MS_PER_DAY);
  const movements = await fetchMovementHistory({
    tenantId: args.tenantId,
    itemId: args.item._id,
    windowDays,
  });
  const dailySeries = buildDailySeries(movements, windowStart, windowEnd);
  const monthlySeries = buildMonthlySeries(dailySeries);
  const features = computeFeatures(dailySeries);

  return {
    generatedAt: new Date().toISOString(),
    windowStart: toIsoDate(windowStart),
    windowEnd: toIsoDate(windowEnd),
    item: {
      id: args.item._id.toString(),
      sku: args.item.sku,
      name: args.item.name,
      unit: args.item.unit,
      type: args.item.type,
      reorderLevel: args.item.reorderLevel,
      movingAverageCost: args.item.movingAverageCost,
      preferredSupplierLeadTimeDays: args.preferredSupplierLeadTimeDays ?? null,
    },
    features,
    dailySeries,
    monthlySeries,
  };
}

/** List items eligible for batch forecasting in this tenant. */
export async function listItemsForBatchForecast(
  tenantId: Types.ObjectId,
): Promise<ItemDoc[]> {
  return Item.find({ tenantId, archivedAt: null })
    .select({ sku: 1, name: 1, unit: 1, type: 1, reorderLevel: 1, movingAverageCost: 1, preferredSupplierId: 1 })
    .lean<ItemDoc[]>()
    .exec();
}

// ---------- helpers ----------

function toIsoDate(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Closed-form least-squares slope for y vs t (t = 0..n-1).
 * Cheaper than fitting a full regression and stable for short series.
 */
function computeLinearTrendSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const sumT = ((n - 1) * n) / 2;
  let sumY = 0;
  let sumTY = 0;
  for (let t = 0; t < n; t += 1) {
    const v = values[t] ?? 0;
    sumY += v;
    sumTY += t * v;
  }
  const sumT2 = ((n - 1) * n * (2 * n - 1)) / 6;
  const denom = n * sumT2 - sumT * sumT;
  if (denom === 0) return 0;
  return (n * sumTY - sumT * sumY) / denom;
}

/**
 * Lightweight seasonality detector: compute the autocorrelation at lag 7
 * (weekly) and lag 30 (monthly), return the larger absolute value
 * clipped to [0, 1]. Not a substitute for spectral analysis, but enough
 * to flag obvious weekly/monthly patterns to the LLM.
 */
function computeSeasonalityScore(values: number[]): number {
  const r7 = autocorrelation(values, 7);
  const r30 = autocorrelation(values, 30);
  return Math.min(1, Math.max(Math.abs(r7), Math.abs(r30)));
}

function autocorrelation(values: number[], lag: number): number {
  if (values.length <= lag + 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i] ?? 0;
    den += (v - mean) ** 2;
    if (i + lag < values.length) {
      const v2 = values[i + lag] ?? 0;
      num += (v - mean) * (v2 - mean);
    }
  }
  if (den === 0) return 0;
  return num / den;
}

function emptyFeatures(windowDays: number): ConsumptionFeatures {
  return {
    windowDays,
    totalConsumed: 0,
    averageDailyConsumption: 0,
    medianDailyConsumption: 0,
    stdDeviation: 0,
    coefficientOfVariation: 0,
    trendSlopeUnitsPerDay: 0,
    trendDirection: 'flat',
    seasonalityScore: 0,
    seasonalityDetected: false,
    zeroConsumptionDays: windowDays,
    peakDayConsumed: 0,
    peakDayDate: null,
    recencyBiasScore: 1,
    dataSparsity: 'empty',
  };
}
