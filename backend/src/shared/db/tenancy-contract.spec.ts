process.env.MONGO_URI ??= 'mongodb://localhost:27017/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= '12345678901234567890123456789012';
process.env.JWT_REFRESH_SECRET ??= '22345678901234567890123456789012';
import { model, Schema, Types } from 'mongoose';
import {
  tenancyPlugin,
  tenantStorage,
  requireTenantScope,
  getTenantScope,
} from './tenancyPlugin.js';

const schema = new Schema({ name: String });
schema.plugin(tenancyPlugin);
const TenantDoc = model('TenantBoundaryValidationFixture', schema);
describe('Mongoose tenant boundaries before database access', () => {
  it('rejects scope-free writes and queries rather than broadening them', async () => {
    expect(getTenantScope()).toBeUndefined();
    expect(() => requireTenantScope()).toThrow('TENANCY_SCOPE_MISSING');
    await expect(new TenantDoc({ name: 'blocked' }).validate()).rejects.toThrow(
      'TENANCY_SCOPE_MISSING',
    );
    await expect(TenantDoc.findOne().exec()).rejects.toThrow('TENANCY_SCOPE_MISSING');
    await expect(TenantDoc.aggregate([]).exec()).rejects.toThrow('TENANCY_SCOPE_MISSING');
    await expect(TenantDoc.insertMany([{ name: 'blocked' }])).rejects.toThrow(
      'TENANCY_SCOPE_MISSING',
    );
  });
  it('injects the scoped tenant on document validation', async () => {
    const tenantId = new Types.ObjectId();
    await tenantStorage.run({ tenantId }, async () => {
      const doc = new TenantDoc({ name: 'scoped' });
      await doc.validate();
      expect(String(doc.get('tenantId'))).toBe(String(tenantId));
      expect(requireTenantScope().tenantId.equals(tenantId)).toBe(true);
    });
  });
  it('rejects a document with a foreign tenant even inside an authenticated scope', async () => {
    await tenantStorage.run({ tenantId: new Types.ObjectId() }, async () => {
      await expect(
        new TenantDoc({ name: 'foreign', tenantId: new Types.ObjectId() }).validate(),
      ).rejects.toThrow('TENANCY_VIOLATION');
      await expect(
        TenantDoc.insertMany([{ name: 'foreign', tenantId: new Types.ObjectId() }]),
      ).rejects.toThrow('TENANCY_VIOLATION');
    });
  });
});
