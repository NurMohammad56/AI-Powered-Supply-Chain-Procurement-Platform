import express from 'express';
import request from 'supertest';

process.env.MONGO_URI ??= 'mongodb://localhost:27017/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= '12345678901234567890123456789012';
process.env.JWT_REFRESH_SECRET ??= '12345678901234567890123456789012';

jest.mock('./upload.service', () => ({
  storeTenantUpload: jest.fn(),
}));

import { parseMultipartJsonField, parseSingleMultipartFile, uploadMultipartFileToBody } from './multipart.js';
import { storeTenantUpload } from './upload.service';

const mockedStoreTenantUpload = jest.mocked(storeTenantUpload);

describe('multipart upload middleware', () => {
  beforeEach(() => {
    mockedStoreTenantUpload.mockReset();
    mockedStoreTenantUpload.mockResolvedValue({
      key: 'tenants/t1/uploads/test.pdf',
      url: 'stub://r2/tenants/t1/uploads/test.pdf',
      uploaded: false,
      filename: 'test.pdf',
      size: 5,
      contentType: 'application/pdf',
      kind: 'document',
    });
  });

  it('injects an uploaded supplier document URL into req.body', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.context = {
        tenantId: { toString: () => 'tenant-1' } as never,
        userId: { toString: () => 'user-1' } as never,
        role: 'owner',
        subscriptionTier: 'trial',
        seats: 1,
        features: new Set(),
        requestId: 'req-1',
      };
      next();
    });
    app.post(
      '/suppliers/:id/documents',
      parseSingleMultipartFile('file'),
      uploadMultipartFileToBody({
        bodyField: 'url',
        folder: 'supplier-documents',
        allowedKinds: ['document'],
        optional: true,
      }),
      (req, res) => res.json(req.body),
    );

    const res = await request(app)
      .post('/suppliers/abc/documents')
      .field('kind', 'contract')
      .attach('file', Buffer.from('%PDF-'), 'contract.pdf');

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('contract');
    expect(res.body.url).toBe('stub://r2/tenants/t1/uploads/test.pdf');
  });

  it('parses JSON payload before injecting the uploaded receipt URL', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.context = {
        tenantId: { toString: () => 'tenant-1' } as never,
        userId: { toString: () => 'user-1' } as never,
        role: 'owner',
        subscriptionTier: 'trial',
        seats: 1,
        features: new Set(),
        requestId: 'req-1',
      };
      next();
    });
    app.post(
      '/purchase-orders/:id/receipts',
      parseSingleMultipartFile('file'),
      parseMultipartJsonField('payload'),
      uploadMultipartFileToBody({
        bodyField: 'grnDocumentUrl',
        folder: 'po-grn-documents',
        allowedKinds: ['image', 'document'],
        optional: true,
      }),
      (req, res) => res.json(req.body),
    );

    const res = await request(app)
      .post('/purchase-orders/abc/receipts')
      .field(
        'payload',
        JSON.stringify({
          warehouseId: 'wh-1',
          notes: 'goods received',
          lines: [{ poLineId: 'l1', itemId: 'i1', quantity: 2 }],
        }),
      )
      .attach('file', Buffer.from('%PDF-'), 'grn.pdf');

    expect(res.status).toBe(200);
    expect(res.body.warehouseId).toBe('wh-1');
    expect(res.body.lines).toEqual([{ poLineId: 'l1', itemId: 'i1', quantity: 2 }]);
    expect(res.body.grnDocumentUrl).toBe('stub://r2/tenants/t1/uploads/test.pdf');
  });
});
