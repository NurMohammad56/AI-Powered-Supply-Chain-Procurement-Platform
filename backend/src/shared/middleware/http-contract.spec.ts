process.env.MONGO_URI ??= 'mongodb://localhost:27017/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= '12345678901234567890123456789012';
process.env.JWT_REFRESH_SECRET ??= '22345678901234567890123456789012';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { z } from 'zod';
import { errorHandler } from './errorHandler.js';
import { rbacFor } from './rbac.js';
import { tierGate } from './tierGate.js';
import { validate } from './validate.js';
import { requireCsrfHeader } from './csrf.js';
import { requestId } from './requestId.js';
import { AppError } from '../errors/AppError.js';
import { ConflictError, InternalError, NotFoundError } from '../errors/HttpErrors.js';
import { Types } from 'mongoose';
import type { SubscriptionTier } from '../auth/types.js';

describe('Real HTTP validation, authorization and safe error envelopes', () => {
  it('preserves a valid correlation ID and replaces an invalid one', async () => {
    const app = express();
    app.use(requestId);
    app.get('/test', (req, res) => res.json({ id: req.id }));
    const valid = await request(app).get('/test').set('X-Request-Id', 'trusted-test-123');
    expect(valid.body.id).toBe('trusted-test-123');
    const invalid = await request(app).get('/test').set('X-Request-Id', 'bad!');
    expect(invalid.body.id).not.toBe('bad!');
  });
  const make = (error: unknown) => {
    const app = express();
    app.use(requestId);
    app.get('/test', (_req, _res, next) => next(error));
    app.use(errorHandler);
    return app;
  };
  it.each([
    [new ConflictError('CONFLICT', 'Conflict'), 409],
    [new NotFoundError(), 404],
    [new InternalError('UPSTREAM_FAILURE'), 500],
    [new mongoose.Error.CastError('ObjectId', 'bad', 'id'), 400],
    [z.object({ quantity: z.number().positive() }).safeParse({ quantity: -1 }).error, 400],
    [Object.assign(new Error('duplicate'), { code: 11000 }), 409],
    [new Error('TENANCY_SCOPE_MISSING: private implementation details'), 500],
    [new Error('upstream secret-api-key must not be exposed'), 500],
  ])('maps error %p to a safe HTTP status', async (error, status) => {
    const response = await request(make(error)).get('/test');
    expect(response.status).toBe(status);
    expect(response.body.error.requestId).toBeTruthy();
    expect(JSON.stringify(response.body)).not.toContain('secret-api-key');
    expect(response.body.error.stack).toBeUndefined();
  });
  it('returns useful field paths for a real Mongoose validation failure', async () => {
    const schema = new mongoose.Schema({ quantity: { type: Number, min: 0, required: true } });
    const Doc = mongoose.model('HttpValidationFixture', schema);
    const error = new Doc({ quantity: -1 }).validateSync();
    const response = await request(make(error)).get('/test');
    expect(response.status).toBe(400);
    expect(response.body.error.details[0].path).toBe('quantity');
  });
  it('keeps unexpected failures opaque without requiring a request ID', async () => {
    const app = express();
    app.get('/test', (_q, _s, next) =>
      next(new AppError(500, 'BROKEN', 'Opaque', undefined, false)),
    );
    app.use(errorHandler);
    expect((await request(app).get('/test')).status).toBe(500);
  });
  it.each([
    [undefined, 'growth', 'po.read', 401],
    ['viewer', 'growth', 'po.approve', 403],
    ['warehouse_staff', 'growth', 'po.receive', 200],
    ['owner', 'trial', 'po.read', 402],
    ['manager', 'growth', 'po.approve', 200],
  ] as const)('enforces role %p and tier %p', async (role, tier, capability, status) => {
    const app = express();
    app.use((req, _res, next) => {
      if (role)
        req.context = {
          tenantId: new Types.ObjectId(),
          userId: new Types.ObjectId(),
          role: role,
          subscriptionTier: tier as SubscriptionTier,
          seats: 1,
          features: new Set(),
          requestId: 'http-test',
        };
      next();
    });
    app.get('/test', rbacFor(capability), tierGate(['growth', 'enterprise']), (_q, res) =>
      res.json({ ok: true }),
    );
    app.use(errorHandler);
    expect((await request(app).get('/test')).status).toBe(status);
  });
  it('requires CSRF header on cookie-bearing refresh requests', async () => {
    const app = express();
    app.post('/test', requireCsrfHeader, (_q, res) => res.json({ ok: true }));
    app.use(errorHandler);
    expect((await request(app).post('/test')).status).toBe(403);
    expect((await request(app).post('/test').set('X-CSRF', 'long-enough-header')).status).toBe(200);
  });
  it('coerces query values and rejects invalid input without retaining raw properties', async () => {
    const app = express();
    app.get(
      '/test',
      validate(z.object({ limit: z.coerce.number().int().positive().max(100) }), 'query'),
      (req, res) => res.json(req.query),
    );
    app.use(errorHandler);
    const good = await request(app).get('/test?limit=10&unexpected=discard');
    expect(good.body).toEqual({ limit: 10 });
    expect((await request(app).get('/test?limit=-1')).status).toBe(400);
  });
});
