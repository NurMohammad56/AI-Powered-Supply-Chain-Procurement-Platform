import { Types } from 'mongoose';

import { BadRequestError, NotFoundError, TooManyRequestsError } from '../../shared/errors/HttpErrors.js';
import { ErrorCodes } from '../../shared/errors/errorCodes.js';
import { assertTenantOwns } from '../../shared/auth/assertTenantOwns.js';
import { recordAudit, AuditActions } from '../../shared/audit/index.js';
import { logger } from '../../config/logger.js';
import { redisCache } from '../../config/redis.js';
import { getIo } from '../../shared/realtime/socketServer.js';
import { SocketEvents, tenantRoom } from '../../shared/realtime/events.js';
import { enqueueForecast } from '../../shared/queue/queues.js';
import type { TenantContext } from '../../shared/auth/types.js';
import type { Page } from '../../shared/utils/pagination.js';
import { Item } from '../inventory/models/item.model.js';
import { Supplier } from '../supplier/models/supplier.model.js';
import { aiRepository } from './ai.repository.js';
import {
  AI_QUOTAS,
  aiUsageRepository,
  checkQuota,
  estimateBatchForecastCost,
  estimateCostMicroUsd,
} from './aiUsage.repository.js';
import { listItemsForBatchForecast, prepareForecastContext } from './dataPreparation.js';
import { runForecastPipeline, type PipelineResult } from './forecastPipeline.js';
import type { ForecastDoc, ForecastHorizonDays } from './models/forecast.model.js';
import type {
  ForecastView,
  GenerateForecastRequest,
  ListForecastsQuery,
  OverrideForecastRequest,
} from './ai.dto.js';

const REDIS_PER_ITEM_TTL_SECONDS = 24 * 60 * 60;
const RATE_LIMIT_PER_ITEM_SECONDS = 6 * 60 * 60;
const RATE_LIMIT_PREFIX = 'ai:forecast:lock:';
const CACHE_PREFIX = 'ai:forecast:result:';

function toView(f: ForecastDoc): ForecastView {
  return {
    id: f._id.toString(),
    itemId: f.itemId.toString(),
    horizonDays: f.horizonDays,
    predictedQuantity: f.predictedQuantity,
    predictedRange: f.predictedRange,
    confidence: f.confidence,
    reasoning: f.reasoning,
    seasonalityDetected: f.seasonalityDetected,
    reorderPointSuggestion: f.reorderPointSuggestion,
    override: f.override
      ? {
          by: f.override.by.toString(),
          at: f.override.at.toISOString(),
          quantity: f.override.quantity,
          justification: f.override.justification,
        }
      : null,
    provenance: f.provenance,
    generatedAt: f.generatedAt.toISOString(),
    expiresAt: f.expiresAt.toISOString(),
    actualQuantity: f.actualQuantity,
    mape: f.mape,
  };
}

function pagedView<T, V>(page: Page<T>, mapper: (row: T) => V) {
  return {
    rows: page.rows.map(mapper),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    limit: page.limit,
  };
}

function rateLimitKey(tenantId: Types.ObjectId, itemId: Types.ObjectId, horizonDays: number): string {
  return `${RATE_LIMIT_PREFIX}${tenantId.toString()}:${itemId.toString()}:${horizonDays}`;
}

function cacheKey(tenantId: Types.ObjectId, itemId: Types.ObjectId, horizonDays: number): string {
  return `${CACHE_PREFIX}${tenantId.toString()}:${itemId.toString()}:${horizonDays}`;
}

interface RunForecastArgs {
  ctx: TenantContext;
  itemId: Types.ObjectId;
  horizonDays: ForecastHorizonDays;
  /** When true, bypass the 6-hour per-item rate limit (used by batch jobs). */
  skipRateLimit?: boolean;
  /** When true, skip Redis caching round trip - the worker doesn't need it. */
  skipReadCache?: boolean;
}

export class AiService {
  /**
   * Generate a forecast for one item synchronously. Caching layers:
   *   - Redis: 24h cache key keyed on (tenantId, itemId, horizonDays)
   *   - MongoDB: Forecast collection, kept indefinitely for history
   *   - Per-item lock: 6h rate-limit prevents thrashing the LLM on the
   *     same item from the dashboard.
   */
  async generateForecast(
    ctx: TenantContext,
    input: GenerateForecastRequest,
  ): Promise<ForecastView> {
    const itemId = new Types.ObjectId(input.itemId);
    const horizonDays = input.horizonDays as ForecastHorizonDays;
    const result = await this.runForecastForItem({ ctx, itemId, horizonDays });
    return toView(result);
  }

  /**
   * Internal entry point used by both the synchronous endpoint and the
   * batch worker. Idempotent under the 6-hour rate-limit window.
   */
  async runForecastForItem(args: RunForecastArgs): Promise<ForecastDoc> {
    const { ctx, itemId, horizonDays } = args;

    // 1. Rate limit (per-item / per-horizon) - cheap Redis SETNX.
    if (!args.skipRateLimit) {
      const key = rateLimitKey(ctx.tenantId, itemId, horizonDays);
      const acquired = await redisCache.set(key, '1', 'EX', RATE_LIMIT_PER_ITEM_SECONDS, 'NX');
      if (acquired === null) {
        const cached = await this.peekCachedResult(ctx.tenantId, itemId, horizonDays);
        if (cached) return cached;
        throw new TooManyRequestsError(
          ErrorCodes.RATE_LIMITED,
          'Forecast for this item was generated within the last 6 hours; please wait or check the cached result',
        );
      }
    }

    // 2. Redis read cache (24h).
    if (!args.skipReadCache) {
      const cached = await this.peekCachedResult(ctx.tenantId, itemId, horizonDays);
      if (cached) return cached;
    }

    // 3. Load the item + supplier lead time.
    const item = await Item.findOne({ _id: itemId, tenantId: ctx.tenantId })
      .lean()
      .exec();
    if (!item) throw new NotFoundError();
    let leadTimeDays: number | null = null;
    if (item.preferredSupplierId) {
      const supplier = await Supplier.findOne({
        _id: item.preferredSupplierId,
        tenantId: ctx.tenantId,
      })
        .select({ leadTimeDays: 1 })
        .lean()
        .exec();
      leadTimeDays = supplier?.leadTimeDays ?? null;
    }

    // 4. Prepare the context (data prep layer).
    const context = await prepareForecastContext({
      tenantId: ctx.tenantId,
      item,
      windowDays: 180,
      preferredSupplierLeadTimeDays: leadTimeDays,
    });

    // 5. Quota gate (estimate prompt size).
    const estimatedTokens = Math.max(1_500, Math.ceil(JSON.stringify(context).length / 4));
    const quota = await checkQuota({
      tenantId: ctx.tenantId,
      tier: ctx.subscriptionTier,
      callKind: 'forecast',
      estimatedTokens,
    });
    if (!quota.allowed) {
      throw new BadRequestError(
        ErrorCodes.AI_QUOTA_EXCEEDED,
        `AI quota exceeded for tier ${ctx.subscriptionTier}: ${quota.reason ?? 'unknown'}`,
        { remaining: quota.remaining },
      );
    }

    // 6. Invoke the LangChain pipeline (Groq -> Gemini failover).
    const pipeline: PipelineResult = await runForecastPipeline(context);

    // 7. Persist the forecast.
    const expiresAt = new Date(Date.now() + REDIS_PER_ITEM_TTL_SECONDS * 1000);
    const horizon = horizonDays;
    const predicted = pickHorizon(pipeline, horizon);
    const created = await aiRepository.create({
      tenantId: ctx.tenantId,
      itemId,
      horizonDays: horizon,
      predictedQuantity: predicted.quantity,
      predictedRange: predicted.range,
      confidence: pipeline.response.confidence,
      reasoning: pipeline.response.reasoning,
      seasonalityDetected: pipeline.response.seasonalityDetected,
      inputSeries: context.dailySeries.slice(-30).map((p) => ({
        periodStart: new Date(`${p.date}T00:00:00Z`),
        periodEnd: new Date(`${p.date}T23:59:59Z`),
        consumed: p.consumed,
      })),
      reorderPointSuggestion: pipeline.response.reorderPointSuggestion
        ? {
            quantity: pipeline.response.reorderPointSuggestion.quantity,
            safetyStockFactor: pipeline.response.reorderPointSuggestion.safetyStockFactor,
            leadTimeDaysAssumed: pipeline.response.reorderPointSuggestion.leadTimeDaysAssumed,
          }
        : null,
      override: null,
      provenance: {
        provider: pipeline.provider,
        model: pipeline.model,
        promptVersion: pipeline.promptVersion,
        failoverInvoked: pipeline.failoverInvoked,
        latencyMs: pipeline.latencyMs,
        cacheHit: false,
        promptTokens: pipeline.promptTokens,
        completionTokens: pipeline.completionTokens,
      },
      rawPrompt: pipeline.rawPrompt.slice(0, 32_000),
      rawResponse: pipeline.rawResponse.slice(0, 32_000),
      generatedAt: new Date(),
      expiresAt,
      actualQuantity: null,
      mape: null,
    });

    // 8. Update usage roll-up + cost telemetry.
    const cost = estimateCostMicroUsd({
      provider: pipeline.provider,
      promptTokens: pipeline.promptTokens,
      completionTokens: pipeline.completionTokens,
    });
    await aiUsageRepository.increment({
      tenantId: ctx.tenantId,
      promptTokens: pipeline.promptTokens,
      completionTokens: pipeline.completionTokens,
      callKind: 'forecast',
      estimatedCostMicroUsd: cost,
    });

    if (quota.softAlert) {
      logger.warn(
        {
          event: 'ai.usage.soft_alert',
          tenantId: ctx.tenantId.toString(),
          tier: ctx.subscriptionTier,
        },
        'Tenant approaching AI quota cap',
      );
    }

    // 9. Cache + emit completion event.
    await redisCache.set(
      cacheKey(ctx.tenantId, itemId, horizon),
      JSON.stringify(created),
      'EX',
      REDIS_PER_ITEM_TTL_SECONDS,
    );

    try {
      const io = getIo();
      io.to(tenantRoom(ctx.tenantId.toString())).emit(SocketEvents.AiForecastCompleted, {
        forecastId: created._id.toString(),
        itemId: itemId.toString(),
        horizonDays: horizon,
        confidence: created.confidence,
        generatedAt: created.generatedAt.toISOString(),
      });
    } catch (err) {
      // Socket may not be initialised in worker contexts; non-fatal.
      logger.debug({ err, event: 'ai.forecast.socket_emit_skipped' }, 'socket emit skipped');
    }

    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.AiForecastGenerated,
      target: { kind: 'forecast', id: created._id },
      payload: {
        itemId: itemId.toString(),
        horizonDays: horizon,
        provider: pipeline.provider,
        failoverInvoked: pipeline.failoverInvoked,
        promptTokens: pipeline.promptTokens,
        completionTokens: pipeline.completionTokens,
        costUsd: cost / 1_000_000,
      },
      requestId: ctx.requestId,
    });

    return created;
  }

  /**
   * Peek at the most recent persisted forecast within the cache window.
   * Returns null if none, or one expired past the 24h boundary.
   */
  async peekCachedResult(
    tenantId: Types.ObjectId,
    itemId: Types.ObjectId,
    horizonDays: number,
  ): Promise<ForecastDoc | null> {
    const raw = await redisCache.get(cacheKey(tenantId, itemId, horizonDays));
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as ForecastDoc;
        return rehydrateForecast(parsed);
      } catch {
        // Corrupt cache entry; ignore and fall through to Mongo.
      }
    }
    const latest = await aiRepository.findLatestForItem({ tenantId, itemId, horizonDays });
    if (!latest) return null;
    if (latest.expiresAt && latest.expiresAt.getTime() < Date.now()) return null;
    return latest;
  }

  /**
   * Enqueue a batch forecast across all (or specified) items for a
   * tenant. Returns the BullMQ job id so the caller can subscribe to
   * progress events on the dashboard.
   */
  async runForecastForAll(args: {
    ctx: TenantContext;
    itemIds?: string[];
  }): Promise<{ batchJobId: string; itemCount: number; estimatedCostUsd: number; estimatedTokens: number }> {
    const items = args.itemIds && args.itemIds.length > 0
      ? await Item.find({
          tenantId: args.ctx.tenantId,
          _id: { $in: args.itemIds.map((id) => new Types.ObjectId(id)) },
          archivedAt: null,
        })
          .select({ _id: 1 })
          .lean()
          .exec()
      : await listItemsForBatchForecast(args.ctx.tenantId);

    if (items.length === 0) {
      throw new BadRequestError(ErrorCodes.BAD_REQUEST, 'No items eligible for forecasting');
    }

    const cap = AI_QUOTAS[args.ctx.subscriptionTier].monthlyForecastCallCap;
    const usage = await aiUsageRepository.getCurrentPeriodUsage(args.ctx.tenantId);
    if (usage.forecastCalls + items.length > cap) {
      throw new BadRequestError(
        ErrorCodes.AI_QUOTA_EXCEEDED,
        `Batch would exceed monthly forecast call cap (${cap}); used ${usage.forecastCalls}, requested ${items.length}`,
      );
    }

    const cost = estimateBatchForecastCost({ itemCount: items.length });

    const enqueued = await enqueueForecast('forecast.batch', {
      tenantId: args.ctx.tenantId.toString(),
      itemIds: items.map((i) => i._id.toString()),
      requestedBy: args.ctx.userId.toString(),
    });

    return {
      batchJobId: enqueued.jobId,
      itemCount: items.length,
      estimatedCostUsd: cost.estimatedCostUsd,
      estimatedTokens: cost.estimatedTokens,
    };
  }

  /** Quota + usage snapshot for the current calendar month. */
  async getUsageSnapshot(ctx: TenantContext): Promise<{
    period: string;
    tier: string;
    used: { tokens: number; forecastCalls: number; reportCalls: number };
    cap: { tokens: number; forecastCalls: number; reportCalls: number };
    estimatedCostUsd: number;
  }> {
    const snapshot = await aiUsageRepository.getCurrentPeriodUsage(ctx.tenantId);
    const cap = AI_QUOTAS[ctx.subscriptionTier];
    return {
      period: snapshot.period.toISOString(),
      tier: ctx.subscriptionTier,
      used: {
        tokens: snapshot.promptTokens + snapshot.completionTokens,
        forecastCalls: snapshot.forecastCalls,
        reportCalls: snapshot.reportCalls,
      },
      cap: {
        tokens: cap.monthlyTokenCap,
        forecastCalls: cap.monthlyForecastCallCap,
        reportCalls: cap.monthlyReportCallCap,
      },
      estimatedCostUsd: snapshot.estimatedCostUsd,
    };
  }

  async getForecast(ctx: TenantContext, id: Types.ObjectId): Promise<ForecastView> {
    const f = await aiRepository.findById(id);
    assertTenantOwns(f, ctx);
    return toView(f);
  }

  async listForecasts(_ctx: TenantContext, query: ListForecastsQuery) {
    const page = await aiRepository.list(query);
    return pagedView(page, toView);
  }

  async overrideForecast(
    ctx: TenantContext,
    id: Types.ObjectId,
    input: OverrideForecastRequest,
  ): Promise<ForecastView> {
    const f = await aiRepository.findById(id);
    assertTenantOwns(f, ctx);
    const updated = await aiRepository.setOverride({
      id,
      by: ctx.userId,
      quantity: input.quantity,
      justification: input.justification,
    });
    if (!updated) throw new NotFoundError();
    void recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorRole: ctx.role,
      action: AuditActions.AiForecastOverridden,
      target: { kind: 'forecast', id },
      payload: { quantity: input.quantity, justification: input.justification },
      requestId: ctx.requestId,
    });
    return toView(updated);
  }
}

function pickHorizon(
  pipeline: PipelineResult,
  horizonDays: ForecastHorizonDays,
): { quantity: number; range: { lower: number; upper: number } } {
  if (horizonDays <= 30) {
    return {
      quantity: pipeline.response.predictedQuantity30Day,
      range: pipeline.response.predictedRange30Day,
    };
  }
  if (horizonDays <= 60) {
    return {
      quantity: pipeline.response.predictedQuantity60Day,
      range: pipeline.response.predictedRange60Day,
    };
  }
  return {
    quantity: pipeline.response.predictedQuantity90Day,
    range: pipeline.response.predictedRange90Day,
  };
}

/** Coerce JSON-revived dates back to Date objects. */
function rehydrateForecast(parsed: ForecastDoc): ForecastDoc {
  return {
    ...parsed,
    generatedAt: new Date(parsed.generatedAt),
    expiresAt: new Date(parsed.expiresAt),
    createdAt: new Date(parsed.createdAt),
    updatedAt: new Date(parsed.updatedAt),
  };
}

export const aiService = new AiService();
