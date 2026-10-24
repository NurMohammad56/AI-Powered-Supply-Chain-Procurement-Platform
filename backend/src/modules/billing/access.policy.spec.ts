process.env.MONGO_URI ??= 'mongodb://localhost:27017/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= '12345678901234567890123456789012';
process.env.JWT_REFRESH_SECRET ??= '12345678901234567890123456789012';
import { subscriptionAccess } from './access.policy.js';
import type { SubscriptionDoc } from './models/subscription.model.js';
describe('subscription access boundaries', () => {
  const now = new Date('2026-10-23T10:00:00Z');
  test.each([
    ['trial', 'trialing', 1, 'full'],
    ['trial', 'trialing', 0, 'read_only'],
    ['trial', 'trialing', -1, 'read_only'],
    ['starter', 'active', 1, 'full'],
    ['growth', 'active', 0, 'read_only'],
    ['enterprise', 'cancelled', 1, 'read_only'],
    ['growth', 'past_due', 1, 'read_only'],
    ['starter', 'incomplete', 1, 'read_only'],
    ['enterprise', 'active', -1, 'read_only'],
  ])('%s %s expires %+dms gives %s', (tier, status, offset, expected) => {
    const end = new Date(now.getTime() + Number(offset));
    expect(
      subscriptionAccess(
        { tier, status, trialEndsAt: end, currentPeriodEnd: end } as SubscriptionDoc,
        now,
      ),
    ).toBe(expected);
  });
});
