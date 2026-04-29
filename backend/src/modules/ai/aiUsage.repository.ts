import type { Types } from 'mongoose';

import type { SubscriptionTier } from '../../shared/auth/types.js';
import { AiUsage, periodKey, type AiUsageDoc } from './models/aiUsage.model.js';

/**
 * Per-tier monthly AI quotas. Values in tokens (input + output combined)
 * and forecast call counts. The middle column is the soft alert
 * threshold (80%); enforcement happens at the hard cap.
 *
 * Numbers are intentionally generous for v1 - we'll tune from real
 * telemetry once tenants are paying.
 */
export const AI_QUOTAS: Record<
  SubscriptionTier,
  {
    monthlyTokenCap: number;
    monthlyForecastCallCap: number;
    monthlyReportCallCap: number;
    softAlertRatio: number;
  }
> = {
  trial: {
    monthlyTokenCap: 100_000,
    monthlyForecastCallCap: 50,
    monthlyReportCallCap: 4,
    softAlertRatio: 0.8,
  },
  starter: {
    monthlyTokenCap: 500_000,
    monthlyForecastCallCap: 500,
    monthlyReportCallCap: 8,
    softAlertRatio: 0.8,
  },
  growth: {
    monthlyTokenCap: 5_000_000,
    monthlyForecastCallCap: 5_000,
    monthlyReportCallCap: 32,
    softAlertRatio: 0.8,
  },
  enterprise: {
    monthlyTokenCap: 50_000_000,
    monthlyForecastCallCap: 50_000,
    monthlyReportCallCap: 200,
    softAlertRatio: 0.85,
  },
};

/**
 * Per-million-token unit cost in USD micros (1e6 = $1) per provider.
 * Used by the cost estimator and the monthly roll-up. Update this when
 * vendors revise pricing.
 */
const COST_PER_MILLION_INPUT_USD_MICROS: Record<string, number> = {
  groq: 590_000, // $0.59 / 1M input tokens (Llama 3.3 70B)
  gemini: 75_000, // $0.075 / 1M input tokens (Gemini 1.5 Flash)
};

const COST_PER_MILLION_OUTPUT_USD_MICROS: Record<string, number> = {
  groq: 790_000, // $0.79 / 1M output tokens
  gemini: 300_000, // $0.30 / 1M output tokens
};

export function estimateCostMicroUsd(args: {
  provider: 'groq' | 'gemini';
  promptTokens: number;
  completionTokens: number;
}): number {
  const inputRate = COST_PER_MILLION_INPUT_USD_MICROS[args.provider] ?? 0;
  const outputRate = COST_PER_MILLION_OUTPUT_USD_MICROS[args.provider] ?? 0;
  const inputCost = (args.promptTokens / 1_000_000) * inputRate;
  const outputCost = (args.completionTokens / 1_000_000) * outputRate;
  return Math.round(inputCost + outputCost);
}

export interface UsageSnapshot {
  period: Date;
  promptTokens: number;
  completionTokens: number;
  forecastCalls: number;
  reportCalls: number;
  estimatedCostMicroUsd: number;
  estimatedCostUsd: number;
}

export class AiUsageRepository {
  async getCurrentPeriodUsage(tenantId: Types.ObjectId): Promise<UsageSnapshot> {
    const period = periodKey();
    const row = await AiUsage.findOne({ tenantId, period }).lean<AiUsageDoc>().exec();
    if (!row) {
      return {
        period,
        promptTokens: 0,
        completionTokens: 0,
        forecastCalls: 0,
        reportCalls: 0,
        estimatedCostMicroUsd: 0,
        estimatedCostUsd: 0,
      };
    }
    return {
      period: row.period,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      forecastCalls: row.forecastCalls,
      reportCalls: row.reportCalls,
      estimatedCostMicroUsd: row.estimatedCostMicroUsd,
      estimatedCostUsd: row.estimatedCostMicroUsd / 1_000_000,
    };
  }

  async increment(args: {
    tenantId: Types.ObjectId;
    promptTokens: number;
    completionTokens: number;
    callKind: 'forecast' | 'report';
    estimatedCostMicroUsd: number;
  }): Promise<AiUsageDoc> {
    const period = periodKey();
    const update: Record<string, unknown> = {
      $inc: {
        promptTokens: args.promptTokens,
        completionTokens: args.completionTokens,
        estimatedCostMicroUsd: args.estimatedCostMicroUsd,
      },
    };
    if (args.callKind === 'forecast') {
      (update.$inc as Record<string, number>).forecastCalls = 1;
    } else {
      (update.$inc as Record<string, number>).reportCalls = 1;
    }

    const doc = await AiUsage.findOneAndUpdate(
      { tenantId: args.tenantId, period },
      update,
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    )
      .lean<AiUsageDoc>()
      .exec();
    if (!doc) throw new Error('Failed to increment AI usage');
    return doc;
  }

  async markAlertedAt(tenantId: Types.ObjectId, period: Date, at: Date): Promise<void> {
    await AiUsage.updateOne({ tenantId, period }, { $set: { alertedAt: at } }).exec();
  }
}

export const aiUsageRepository = new AiUsageRepository();

export interface QuotaCheckResult {
  allowed: boolean;
  remaining: {
    tokens: number;
    forecastCalls: number;
    reportCalls: number;
  };
  softAlert: boolean;
  reason?: 'token_cap' | 'forecast_call_cap' | 'report_call_cap';
}

/**
 * Evaluate a quota gate for the given tenant + tier and the kind of
 * call about to be made. Soft alert is reported separately so the
 * caller can fire a notification without blocking the call.
 */
export async function checkQuota(args: {
  tenantId: Types.ObjectId;
  tier: SubscriptionTier;
  callKind: 'forecast' | 'report';
  estimatedTokens: number;
}): Promise<QuotaCheckResult> {
  const quota = AI_QUOTAS[args.tier];
  const usage = await aiUsageRepository.getCurrentPeriodUsage(args.tenantId);
  const usedTokens = usage.promptTokens + usage.completionTokens;
  const remainingTokens = Math.max(0, quota.monthlyTokenCap - usedTokens);
  const remainingForecasts = Math.max(0, quota.monthlyForecastCallCap - usage.forecastCalls);
  const remainingReports = Math.max(0, quota.monthlyReportCallCap - usage.reportCalls);

  if (usedTokens + args.estimatedTokens > quota.monthlyTokenCap) {
    return {
      allowed: false,
      remaining: { tokens: remainingTokens, forecastCalls: remainingForecasts, reportCalls: remainingReports },
      softAlert: false,
      reason: 'token_cap',
    };
  }
  if (args.callKind === 'forecast' && usage.forecastCalls + 1 > quota.monthlyForecastCallCap) {
    return {
      allowed: false,
      remaining: { tokens: remainingTokens, forecastCalls: remainingForecasts, reportCalls: remainingReports },
      softAlert: false,
      reason: 'forecast_call_cap',
    };
  }
  if (args.callKind === 'report' && usage.reportCalls + 1 > quota.monthlyReportCallCap) {
    return {
      allowed: false,
      remaining: { tokens: remainingTokens, forecastCalls: remainingForecasts, reportCalls: remainingReports },
      softAlert: false,
      reason: 'report_call_cap',
    };
  }
  const projectedRatio = (usedTokens + args.estimatedTokens) / quota.monthlyTokenCap;
  return {
    allowed: true,
    remaining: { tokens: remainingTokens, forecastCalls: remainingForecasts, reportCalls: remainingReports },
    softAlert: projectedRatio >= quota.softAlertRatio,
  };
}

/**
 * Estimate the cost of a *batch* forecast for cost-aware UX.
 * Calculates against the cheaper provider as the optimistic case.
 */
export function estimateBatchForecastCost(args: {
  itemCount: number;
  avgPromptTokensPerItem?: number;
  avgCompletionTokensPerItem?: number;
}): { estimatedTokens: number; estimatedCostUsd: number } {
  const promptPer = args.avgPromptTokensPerItem ?? 4_000;
  const completionPer = args.avgCompletionTokensPerItem ?? 600;
  const totalPrompt = args.itemCount * promptPer;
  const totalCompletion = args.itemCount * completionPer;
  const cheaperCost =
    estimateCostMicroUsd({ provider: 'gemini', promptTokens: totalPrompt, completionTokens: totalCompletion }) /
    1_000_000;
  return {
    estimatedTokens: totalPrompt + totalCompletion,
    estimatedCostUsd: Math.round(cheaperCost * 100) / 100,
  };
}
