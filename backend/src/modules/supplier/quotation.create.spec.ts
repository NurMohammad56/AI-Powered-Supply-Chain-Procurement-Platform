import { Types } from 'mongoose';

process.env.MONGO_URI ??= 'mongodb://localhost:27017/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= '12345678901234567890123456789012';
process.env.JWT_REFRESH_SECRET ??= '12345678901234567890123456789012';

jest.mock('../../config/env.js', () => ({
  env: {
    FRONTEND_BASE_URL: 'http://localhost:3000',
  },
}));

jest.mock('../../shared/audit/index.js', () => ({
  recordAudit: jest.fn(),
  AuditActions: {
    QuoteRequestCreated: 'quote.request.created',
  },
}));

jest.mock('../../config/logger.js', () => ({
  logger: {
    warn: jest.fn(),
  },
}));

jest.mock('../../shared/queue/queues.js', () => ({
  enqueueEmail: jest.fn(),
  enqueueForecast: jest.fn(),
  enqueueScheduled: jest.fn(),
}));

jest.mock('./quotation.repository.js', () => ({
  quotationRepository: {
    create: jest.fn(),
  },
}));

jest.mock('./supplier.repository.js', () => ({
  supplierRepository: {
    findManyByIds: jest.fn(),
  },
}));

import { quotationService } from './quotation.service.js';
import { enqueueEmail, enqueueScheduled } from '../../shared/queue/queues.js';
import { quotationRepository } from './quotation.repository.js';
import { supplierRepository } from './supplier.repository.js';

describe('quotationService.create', () => {
  const tenantId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const supplierId1 = new Types.ObjectId();
  const supplierId2 = new Types.ObjectId();
  const itemId = new Types.ObjectId();
  const quotationId = new Types.ObjectId();

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

  it('creates an RFQ, schedules expiry, and enqueues supplier invitation emails', async () => {
    jest.mocked(supplierRepository.findManyByIds).mockResolvedValue([
      {
        _id: supplierId1,
        tenantId,
        legalName: 'Supplier One Ltd',
        tradingName: 'Supplier One',
      },
      {
        _id: supplierId2,
        tenantId,
        legalName: 'Supplier Two Ltd',
        tradingName: null,
      },
    ] as never);

    const created = {
      _id: quotationId,
      tenantId,
      number: 'RFQ-TEST-001',
      status: 'open',
      requestedBy: userId,
      validUntil: new Date('2026-08-10T23:59:59.000Z'),
      lines: [
        {
          itemId,
          quantity: 1000,
          targetUnitPrice: null,
          targetDeliveryDate: null,
          remarks: null,
        },
      ],
      supplierInvitations: [
        {
          supplierId: supplierId1,
          responseToken: 'token-one',
          invitedAt: new Date('2026-08-05T10:00:00.000Z'),
          invitedContactEmail: 'sales1@example.com',
          response: null,
        },
        {
          supplierId: supplierId2,
          responseToken: 'token-two',
          invitedAt: new Date('2026-08-05T10:00:00.000Z'),
          invitedContactEmail: 'sales2@example.com',
          response: null,
        },
      ],
      aiRecommendation: null,
      acceptedSupplierId: null,
      acceptedAt: null,
      createdAt: new Date('2026-08-05T10:00:00.000Z'),
      updatedAt: new Date('2026-08-05T10:00:00.000Z'),
    };
    jest.mocked(quotationRepository.create).mockResolvedValue(created as never);
    jest.mocked(enqueueScheduled).mockResolvedValue({ jobId: 'scheduled-1' } as never);
    jest.mocked(enqueueEmail).mockResolvedValue(undefined as never);

    const result = await quotationService.create(ctx, {
      validUntil: '2026-08-10T23:59:59.000Z',
      lines: [{ itemId: itemId.toString(), quantity: 1000 }],
      invitedSuppliers: [
        { supplierId: supplierId1.toString(), contactEmail: 'sales1@example.com' },
        { supplierId: supplierId2.toString(), contactEmail: 'sales2@example.com' },
      ],
    });

    expect(enqueueScheduled).toHaveBeenCalledWith(
      'scheduled.quotation.expiry_check',
      expect.objectContaining({
        tenantId: tenantId.toString(),
        quotationId: quotationId.toString(),
      }),
      expect.objectContaining({
        delay: expect.any(Number),
      }),
    );
    expect(enqueueEmail).toHaveBeenCalledTimes(2);
    expect(enqueueEmail).toHaveBeenNthCalledWith(
      1,
      'email.send',
      expect.objectContaining({
        to: 'sales1@example.com',
        subject: 'RFQ invitation: RFQ-TEST-001',
        html: expect.stringContaining('token-one'),
      }),
    );
    expect(enqueueEmail).toHaveBeenNthCalledWith(
      2,
      'email.send',
      expect.objectContaining({
        to: 'sales2@example.com',
        subject: 'RFQ invitation: RFQ-TEST-001',
        html: expect.stringContaining('token-two'),
      }),
    );
    expect(result.number).toBe('RFQ-TEST-001');
  });
});
