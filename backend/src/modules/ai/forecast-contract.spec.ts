process.env.MONGO_URI ??= 'mongodb://localhost:27017/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= '12345678901234567890123456789012';
process.env.JWT_REFRESH_SECRET ??= '12345678901234567890123456789012';

import {
  buildDailySeries,
  buildMonthlySeries,
  computeFeatures,
  sumConsumed,
} from './dataPreparation.js';
import {
  coerceForecast,
  deterministicBaseline,
  extractJsonObject,
  StrictForecastResponseSchema,
} from './validators/forecastValidator.js';

const features = computeFeatures(
  Array.from({ length: 30 }, (_, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, '0')}`,
    consumed: 10,
  })),
);
const args = { features, leadTimeDays: 14, rawJson: undefined as unknown };
describe('Garments consumption and AI response contract', () => {
  it.each(
    [
      [0],
      [1],
      [0, 0, 0, 0, 0],
      [1, 2, 3, 4, 5],
      [5, 4, 3, 2, 1],
      Array.from({ length: 30 }, (_, i) => (i < 2 ? 100 : 0)),
      Array.from({ length: 30 }, (_, i) => (i < 8 ? 100 : 0)),
      Array.from({ length: 60 }, (_, i) => (i % 7 === 5 ? 0 : 100)),
      Array.from({ length: 60 }, (_, i) => (i < 30 ? 0 : 100)),
    ].map((values) => ({ values })),
  )('handles zero, sparse, seasonal and changing garments demand: %p', ({ values }) => {
    const daily = values.map((consumed, i) => ({
      date: new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10),
      consumed,
    }));
    const actual = computeFeatures(daily);
    expect(Number.isFinite(actual.averageDailyConsumption)).toBe(true);
    expect(actual.totalConsumed).toBe(values.reduce((sum, x) => sum + x, 0));
    expect(actual.zeroConsumptionDays).toBe(values.filter((x) => x === 0).length);
    expect(actual.seasonalityScore).toBeGreaterThanOrEqual(0);
    expect(
      StrictForecastResponseSchema.safeParse(deterministicBaseline({ ...args, features: actual }))
        .success,
    ).toBe(true);
  });
  it.each([
    { predictedQuantity30Day: 10, reorderPointSuggestion: {} },
    {
      predictedQuantity60Day: 20,
      predictedRange30Day: { lower: 1 },
      predictedRange60Day: { upper: 25 },
      reasoning: '',
      anomalies: ['Review sparse history'],
    },
    {
      predictedQuantity90Day: 30,
      predictedRange90Day: {},
      reorderPointSuggestion: { safetyStockFactor: 2, leadTimeDaysAssumed: 10 },
    },
  ])('repairs partial output without violating the published forecast schema', (rawJson) => {
    const result = coerceForecast({ ...args, features: computeFeatures([]), rawJson });
    expect(result.coerced).toBe(true);
    expect(StrictForecastResponseSchema.safeParse(result.response).success).toBe(true);
  });
  it('excludes warehouse transfers, loss and corrections from production demand', () => {
    const date = new Date('2026-09-01T04:00:00Z');
    const rows = [
      { performedAt: date, type: 'out', quantity: -10 },
      { performedAt: date, type: 'transfer_out', quantity: -100 },
      { performedAt: date, type: 'adjustment', reasonCode: 'damage', quantity: -20 },
      { performedAt: date, type: 'adjustment', reasonCode: 'production_consume', quantity: -5 },
    ];
    expect(sumConsumed(rows)).toBe(15);
    expect(buildDailySeries(rows, new Date('2026-09-01'), new Date('2026-09-03'))).toEqual([
      { date: '2026-09-01', consumed: 15 },
      { date: '2026-09-02', consumed: 0 },
      { date: '2026-09-03', consumed: 0 },
    ]);
  });
  it('does not import movements outside the forecast window', () =>
    expect(
      buildDailySeries(
        [{ performedAt: new Date('2026-08-01'), type: 'out', quantity: -10 }],
        new Date('2026-09-01'),
        new Date('2026-09-01'),
      ),
    ).toEqual([{ date: '2026-09-01', consumed: 0 }]));
  it('aggregates monthly production totals', () =>
    expect(
      buildMonthlySeries([
        { date: '2026-08-31', consumed: 10 },
        { date: '2026-09-01', consumed: 20 },
      ]),
    ).toEqual([
      { month: '2026-08', consumed: 10, movementCount: 1 },
      { month: '2026-09', consumed: 20, movementCount: 1 },
    ]));
  it('returns a finite zero baseline for no history', () => {
    const response = deterministicBaseline({ ...args, features: computeFeatures([]) });
    expect(response.predictedQuantity90Day).toBe(0);
    expect(response.confidence).toBe('low');
    expect(response.reorderPointSuggestion).toBeNull();
  });
  it.each([undefined, null, {}, [], { reasoning: 'invented prose' }, 'invalid'])(
    'labels unusable provider output as fallback: %p',
    (rawJson) => expect(coerceForecast({ ...args, rawJson }).fallback).toBe(true),
  );
  it('repairs inverted ranges and decreasing horizons without negative quantities', () => {
    const result = coerceForecast({
      ...args,
      rawJson: {
        predictedQuantity30Day: 100,
        predictedQuantity60Day: 20,
        predictedQuantity90Day: -5,
        predictedRange30Day: { lower: 150, upper: 10 },
        reorderPointSuggestion: { quantity: 50, safetyStockFactor: -4, leadTimeDaysAssumed: 999 },
      },
    });
    expect(result.fallback).toBe(false);
    expect(result.response.predictedQuantity90Day).toBe(100);
    expect(StrictForecastResponseSchema.safeParse(result.response).success).toBe(true);
    expect(result.response.predictedRange30Day.lower).toBeLessThanOrEqual(100);
    expect(result.response.predictedRange30Day.upper).toBeGreaterThanOrEqual(100);
  });
  it.each(['```json\n{"quantity":10}\n```', 'Here is the result: {"quantity":10}'])(
    'extracts provider JSON from formatting',
    (text) => expect(extractJsonObject(text)).toEqual({ quantity: 10 }),
  );
  it('rejects non-JSON output', () => expect(() => extractJsonObject('no forecast')).toThrow());
  it('retains a valid provider forecast without calling it fallback', () => {
    const valid = {
      ...deterministicBaseline(args),
      confidence: 'high',
      reasoning: 'Supplier lead time and recent production used.',
    };
    expect(coerceForecast({ ...args, rawJson: valid })).toMatchObject({
      fallback: false,
      coerced: false,
      response: { confidence: 'high' },
    });
  });
});
