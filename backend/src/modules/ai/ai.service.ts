import { Types } from 'mongoose';

import { NotFoundError, NotImplementedError } from '../../shared/errors/HttpErrors.js';
import { assertTenantOwns } from '../../shared/auth/assertTenantOwns.js';
import { recordAudit, AuditActions } from '../../shared/audit/index.js';
import type { TenantContext } from '../../shared/auth/types.js';
import type { Page } from '../../shared/utils/pagination.js';
import { aiRepository } from './ai.repository.js';
import type { ForecastDoc } from './models/forecast.model.js';
import type {
  ForecastView,
  GenerateForecastRequest,
  ListForecastsQuery,
  OverrideForecastRequest,
} from './ai.dto.js';

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

export class AiService {
  /**
   * Forecast generation requires the LangChain pipeline (Groq + Gemini
   * failover) which lands in a later module. Until then this endpoint
   * returns 501 NotImplemented; the route is wired so the contract is
   * stable.
   */
  async generateForecast(
    _ctx: TenantContext,
    _input: GenerateForecastRequest,
  ): Promise<ForecastView> {
    throw new NotImplementedError(
      'ai.forecast.generate',
      'Forecast generation pipeline is not yet implemented; see SDD §6.4',
    );
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

export const aiService = new AiService();
