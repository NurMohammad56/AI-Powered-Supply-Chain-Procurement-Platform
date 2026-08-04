import { Types } from 'mongoose';

process.env.MONGO_URI ??= 'mongodb://localhost:27017/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= '12345678901234567890123456789012';
process.env.JWT_REFRESH_SECRET ??= '12345678901234567890123456789012';

jest.mock('../../shared/audit/index.js', () => ({
  recordAudit: jest.fn(),
  AuditActions: {
    AiForecastGenerated: 'ai.forecast.generated',
  },
}));

jest.mock('../../config/logger.js', () => ({
  logger: {
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../config/redis.js', () => ({
  redisCache: {
    get: jest.fn(),
    set: jest.fn(),
  },
}));

jest.mock('../../shared/realtime/socketServer.js', () => ({
  getIo: jest.fn(() => ({
    to: jest.fn(() => ({
      emit: jest.fn(),
    })),
  })),
}));

jest.mock('../../shared/queue/queues.js', () => ({
  enqueueForecast: jest.fn(),
}));

jest.mock('../inventory/models/item.model.js', () => ({
  Item: {
    findOne: jest.fn(),
  },
}));

jest.mock('../supplier/models/supplier.model.js', () => ({
  Supplier: {
    findOne: jest.fn(),
  },
}));

jest.mock('./ai.repository.js', () => ({
  aiRepository: {
    create: jest.fn(),
    findLatestForItem: jest.fn(),
    findById: jest.fn(),
    list: jest.fn(),
    setOverride: jest.fn(),
  },
}));

jest.mock('./aiUsage.repository.js', () => ({
  AI_QUOTAS: {
    trial: { monthlyTokenCap: 10000, monthlyForecastCallCap: 100, monthlyReportCallCap: 10 },
  },
  aiUsageRepository: {
    increment: jest.fn(),
    getCurrentPeriodUsage: jest.fn(),
  },
  checkQuota: jest.fn(),
  estimateBatchForecastCost: jest.fn(),
  estimateCostMicroUsd: jest.fn(),
}));

jest.mock('./dataPreparation.js', () => ({
  prepareForecastContext: jest.fn(),
  listItemsForBatchForecast: jest.fn(),
}));

jest.mock('./forecastPipeline.js', () => ({
  runForecastPipeline: jest.fn(),
}));

import { aiService } from './ai.service.js';
import { redisCache } from '../../config/redis.js';
import { Item } from '../inventory/models/item.model.js';
import { Supplier } from '../supplier/models/supplier.model.js';
import { aiRepository } from './ai.repository.js';
import { aiUsageRepository, checkQuota, estimateCostMicroUsd } from './aiUsage.repository.js';
import { prepareForecastContext } from './dataPreparation.js';
import { runForecastPipeline } from './forecastPipeline.js';

describe('aiService.generateForecast', () => {
  const tenantId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const itemId = new Types.ObjectId();
  const supplierId = new Types.ObjectId();

  const ctx = {
    tenantId,
    userId,
    role: 'owner',
    subscriptionTier: 'trial',
    seats: 1,
    features: new Set<string>(),
    requestId: 'req-1',
  } as const;

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('generates and persists a forecast through the AI pipeline path', async () => {
    const now = new Date('2026-08-02T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockReturnValue(now.getTime());

    jest.mocked(redisCache.set).mockResolvedValue('OK');
    jest.mocked(redisCache.get).mockResolvedValue(null);

    jest.mocked(Item.findOne).mockReturnValue({
      lean: () => ({
        exec: async () => ({
          _id: itemId,
          tenantId,
          sku: 'COTTON-001',
          name: 'Raw Cotton',
          unit: 'kg',
          preferredSupplierId: supplierId,
        }),
      }),
    } as never);

    jest.mocked(Supplier.findOne).mockReturnValue({
      select: () => ({
        lean: () => ({
          exec: async () => ({
            _id: supplierId,
            leadTimeDays: 12,
          }),
        }),
      }),
    } as never);

    jest.mocked(prepareForecastContext).mockResolvedValue({
      item: {
        id: itemId.toString(),
        sku: 'COTTON-001',
        name: 'Raw Cotton',
        unit: 'kg',
        preferredSupplierLeadTimeDays: 12,
      },
      features: {
        averageDailyConsumption: 18,
        recent30DayConsumption: 540,
      },
      dailySeries: [
        { date: '2026-07-31', consumed: 20 },
        { date: '2026-08-01', consumed: 18 },
      ],
    } as never);

    jest.mocked(checkQuota).mockResolvedValue({
      allowed: true,
      softAlert: false,
      remaining: { tokens: 9000, forecastCalls: 99, reportCalls: 10 },
    });

    jest.mocked(runForecastPipeline).mockResolvedValue({
      response: {
        predictedQuantity30Day: 600,
        predictedRange30Day: { lower: 560, upper: 640 },
        predictedQuantity60Day: 1180,
        predictedRange60Day: { lower: 1100, upper: 1260 },
        predictedQuantity90Day: 1750,
        predictedRange90Day: { lower: 1650, upper: 1850 },
        confidence: 'medium',
        reasoning: 'Demand is stable with mild upward momentum.',
        seasonalityDetected: false,
        reorderPointSuggestion: {
          quantity: 220,
          safetyStockFactor: 1.4,
          leadTimeDaysAssumed: 12,
        },
      },
      provider: 'groq',
      model: 'llama',
      promptVersion: 'forecast-v1.0.1',
      failoverInvoked: false,
      latencyMs: 250,
      promptTokens: 800,
      completionTokens: 120,
      rawPrompt: 'prompt',
      rawResponse: '{"predictedQuantity30Day":600}',
      coerced: false,
      fallback: false,
    } as never);

    jest.mocked(estimateCostMicroUsd).mockReturnValue(1250);

    jest.mocked(aiRepository.create).mockResolvedValue({
      _id: new Types.ObjectId(),
      tenantId,
      itemId,
      horizonDays: 30,
      predictedQuantity: 600,
      predictedRange: { lower: 560, upper: 640 },
      confidence: 'medium',
      reasoning: 'Demand is stable with mild upward momentum.',
      seasonalityDetected: false,
      reorderPointSuggestion: {
        quantity: 220,
        safetyStockFactor: 1.4,
        leadTimeDaysAssumed: 12,
      },
      override: null,
      provenance: {
        provider: 'groq',
        model: 'llama',
        promptVersion: 'forecast-v1.0.1',
        failoverInvoked: false,
        latencyMs: 250,
        cacheHit: false,
        promptTokens: 800,
        completionTokens: 120,
      },
      generatedAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      actualQuantity: null,
      mape: null,
      createdAt: now,
      updatedAt: now,
    } as never);

    const result = await aiService.generateForecast(ctx, {
      itemId: itemId.toString(),
      horizonDays: 30,
    });

    expect(runForecastPipeline).toHaveBeenCalled();
    expect(aiRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        itemId,
        horizonDays: 30,
        predictedQuantity: 600,
      }),
    );
    expect(aiUsageRepository.increment).toHaveBeenCalled();
    expect(result.predictedQuantity).toBe(600);
    expect(result.provenance.provider).toBe('groq');
  });
});
