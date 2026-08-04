import type { BadRequestError } from '../errors/HttpErrors.js';

process.env.MONGO_URI ??= 'mongodb://localhost:27017/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= '12345678901234567890123456789012';
process.env.JWT_REFRESH_SECRET ??= '12345678901234567890123456789012';

jest.mock('../storage/r2.client', () => ({
  tenantKey: jest.fn((tenantId: string, folder: string, filename: string) =>
    `tenants/${tenantId}/${folder}/2026-08-02/${filename}`),
  uploadObject: jest.fn(),
}));

import * as r2Client from '../storage/r2.client';
import { storeTenantUpload } from './upload.service';

describe('storeTenantUpload', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uploads a validated image and returns the stored reference', async () => {
    const uploadSpy = jest.spyOn(r2Client, 'uploadObject').mockResolvedValue({
      key: 'tenants/t1/inventory-attachments/2026-08-02/proof.png',
      bucket: 'stub-bucket',
      url: 'stub://r2/tenants/t1/inventory-attachments/2026-08-02/proof.png',
      uploaded: false,
    });

    const result = await storeTenantUpload({
      tenantId: 't1',
      folder: 'inventory-attachments',
      allowedKinds: ['image', 'document'],
      file: {
        fieldname: 'file',
        originalname: 'proof.png',
        encoding: '7bit',
        mimetype: 'image/png',
        size: 4,
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        stream: undefined as never,
        destination: '',
        filename: '',
        path: '',
      },
    });

    expect(uploadSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: 'image/png',
      }),
    );
    expect(result.kind).toBe('image');
    expect(result.filename).toBe('proof.png');
    expect(result.url).toContain('stub://r2/');
  });

  it('rejects files that do not match any allowed kind', async () => {
    await expect(
      storeTenantUpload({
        tenantId: 't1',
        folder: 'supplier-documents',
        allowedKinds: ['document'],
        file: {
          fieldname: 'file',
          originalname: 'photo.png',
          encoding: '7bit',
          mimetype: 'image/png',
          size: 4,
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          stream: undefined as never,
          destination: '',
          filename: '',
          path: '',
        },
      }),
    ).rejects.toMatchObject<Partial<BadRequestError>>({
      code: 'VALIDATION_FAILED',
      status: 400,
    });
  });
});
