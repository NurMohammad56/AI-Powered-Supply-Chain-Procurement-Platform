process.env.MONGO_URI ??= 'mongodb://localhost:27017/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= '12345678901234567890123456789012';
process.env.JWT_REFRESH_SECRET ??= '22345678901234567890123456789012';

import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from './password.js';
import { assignableRolesBy, roleHasCapability } from './rbac.js';
import {
  issueAccessToken,
  issueRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from './jwt.js';
import { assertTenantOwns } from './assertTenantOwns.js';
import {
  buildCursor,
  cursorQuerySchema,
  decodeCursor,
  encodeCursor,
  paginate,
} from '../utils/pagination.js';
import type { TenantContext } from './types.js';

describe('Authentication, permissions and cursor boundaries', () => {
  it("does not accept a longer password sharing bcrypt's first 72 bytes", async () => {
    const exact = 'Aa1!' + 'x'.repeat(68),
      hash = await hashPassword(exact);
    expect(checkPasswordPolicy(exact).ok).toBe(true);
    expect(checkPasswordPolicy(exact + 'extra').ok).toBe(false);
    expect(checkPasswordPolicy('Aa1!' + 'ঢ'.repeat(30)).ok).toBe(false);
    expect(await verifyPassword(exact, hash)).toBe(true);
    expect(await verifyPassword(exact + 'extra', hash)).toBe(false);
  });
  it('reports an expired credential distinctly from a forged one', () => {
    const token = jwt.sign({ sub: 'expired', exp: 1 }, env.JWT_ACCESS_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    expect(() => verifyAccessToken(token)).toThrow('expired');
    expect(() => verifyRefreshToken('invalid')).toThrow('invalid');
  });
  it.each([
    'short',
    'longpasswordonly',
    'UPPERCASE123!',
    'lowercase123!',
    'NoDigitsHere!',
    'NoSymbol12345',
    'x'.repeat(129),
  ])('rejects a weak or oversized password', (password) =>
    expect(checkPasswordPolicy(password).ok).toBe(false),
  );
  it('uses a salted password hash and refuses an incorrect password', async () => {
    const hash = await hashPassword('GarmentsDemo!2026');
    expect(hash).not.toContain('GarmentsDemo');
    expect(await verifyPassword('GarmentsDemo!2026', hash)).toBe(true);
    expect(await verifyPassword('DifferentPass!2026', hash)).toBe(false);
  });
  it('allows receiving staff to post receipts without approving or cancelling orders', () => {
    expect(roleHasCapability('warehouse_staff', 'po.receive')).toBe(true);
    expect(roleHasCapability('warehouse_staff', 'po.approve')).toBe(false);
    expect(roleHasCapability('warehouse_staff', 'po.cancel')).toBe(false);
  });
  it('does not allow a viewer to mutate inventory or assign roles', () => {
    expect(roleHasCapability('viewer', 'inventory.item.read')).toBe(true);
    expect(roleHasCapability('viewer', 'inventory.movement.create')).toBe(false);
    expect(assignableRolesBy('viewer')).toEqual([]);
  });
  it('prevents a manager from granting ownership', () => {
    expect(assignableRolesBy('manager')).not.toContain('owner');
    expect(assignableRolesBy('owner')).toContain('owner');
  });
  it('binds access claims to tenant, role and plan, and rejects signature tampering', () => {
    const tenantId = new Types.ObjectId(),
      userId = new Types.ObjectId();
    const issued = issueAccessToken({
      tenantId,
      userId,
      role: 'manager',
      tier: 'growth',
      seats: 15,
      features: ['ai_forecast'],
    });
    expect(verifyAccessToken(issued.token)).toMatchObject({
      tenantId: String(tenantId),
      sub: String(userId),
      role: 'manager',
      tier: 'growth',
      seats: 15,
    });
    const parts = issued.token.split('.');
    parts[1] = Buffer.from(JSON.stringify({ tenantId: String(tenantId), role: 'owner' })).toString(
      'base64url',
    );
    expect(() => verifyAccessToken(parts.join('.'))).toThrow();
  });
  it('keeps access and refresh credentials separate', () => {
    const input = {
      tenantId: new Types.ObjectId(),
      userId: new Types.ObjectId(),
      family: 'security-test',
    };
    const refresh = issueRefreshToken(input);
    expect(verifyRefreshToken(refresh.token).family).toBe('security-test');
    expect(() => verifyAccessToken(refresh.token)).toThrow();
  });
  it('returns the same not-found outcome for a missing and foreign-tenant record', () => {
    const tenantId = new Types.ObjectId();
    const ctx = {
      tenantId,
      userId: new Types.ObjectId(),
      role: 'viewer',
      subscriptionTier: 'growth',
      requestId: 'security-test',
      seats: 1,
      features: new Set(),
    } as TenantContext;
    expect(() => assertTenantOwns(null, ctx)).toThrow('Resource not found');
    expect(() => assertTenantOwns({ tenantId: new Types.ObjectId() }, ctx)).toThrow(
      'Resource not found',
    );
    expect(() => assertTenantOwns({ tenantId }, ctx)).not.toThrow();
  });
  it.each(['garbage', '!!@@', '', undefined])('handles malformed cursor input', (value) =>
    expect(decodeCursor(value)).toBeNull(),
  );
  it('paginates without losing the next ObjectId or returning the sentinel row', () => {
    const rows = [
      { _id: new Types.ObjectId() },
      { _id: new Types.ObjectId() },
      { _id: new Types.ObjectId() },
    ];
    const page = paginate(rows, 2);
    expect(page.rows).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(String(decodeCursor(page.nextCursor!))).toBe(String(rows[1]!._id));
    expect(paginate(rows, 3).nextCursor).toBeNull();
    expect(encodeCursor(undefined)).toBeNull();
    expect(buildCursor({ limit: 25 })).toEqual({ limit: 25, after: null });
  });
  it.each([0, -1, 101, 'NaN'])('rejects invalid page sizes', (limit) =>
    expect(cursorQuerySchema.safeParse({ limit }).success).toBe(false),
  );
});
