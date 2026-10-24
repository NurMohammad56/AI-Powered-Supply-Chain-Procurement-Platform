process.env.MONGO_URI ??= 'mongodb://localhost:27017/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= '12345678901234567890123456789012';
process.env.JWT_REFRESH_SECRET ??= '12345678901234567890123456789012';
import { Types } from 'mongoose';
import { aiUsageRepository, checkQuota } from './aiUsage.repository.js';

describe('unrestricted trial AI usage', () => {
  afterEach(() => jest.restoreAllMocks());
  test.each(['forecast', 'report'] as const)(
    'trial %s remains available after heavy usage',
    async (callKind) => {
      jest.spyOn(aiUsageRepository, 'getCurrentPeriodUsage').mockResolvedValue({
        period: new Date(),
        promptTokens: 1_000_000_000,
        completionTokens: 1_000_000_000,
        forecastCalls: 1_000_000,
        reportCalls: 1_000_000,
        estimatedCostMicroUsd: 0,
        estimatedCostUsd: 0,
      });
      const result = await checkQuota({
        tenantId: new Types.ObjectId(),
        tier: 'trial',
        callKind,
        estimatedTokens: 100_000,
      });
      expect(result.allowed).toBe(true);
      expect(result.softAlert).toBe(false);
    },
  );
  test('paid plans retain their quota enforcement', async () => {
    jest.spyOn(aiUsageRepository, 'getCurrentPeriodUsage').mockResolvedValue({
      period: new Date(),
      promptTokens: 10_000_000,
      completionTokens: 0,
      forecastCalls: 0,
      reportCalls: 0,
      estimatedCostMicroUsd: 0,
      estimatedCostUsd: 0,
    });
    expect(
      (
        await checkQuota({
          tenantId: new Types.ObjectId(),
          tier: 'growth',
          callKind: 'forecast',
          estimatedTokens: 100,
        })
      ).allowed,
    ).toBe(false);
  });
});
