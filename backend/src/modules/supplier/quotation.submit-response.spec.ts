import { Types } from 'mongoose';

process.env.MONGO_URI ??= 'mongodb://localhost:27017/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= '12345678901234567890123456789012';
process.env.JWT_REFRESH_SECRET ??= '12345678901234567890123456789012';

jest.mock('../../shared/audit/index.js', () => ({
  recordAudit: jest.fn(),
  AuditActions: {
    QuoteResponseReceived: 'quote.response.received',
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
    findByTokenGlobal: jest.fn(),
    withScope: jest.fn(),
    findByToken: jest.fn(),
    setInvitationResponse: jest.fn(),
  },
}));

jest.mock('./supplier.repository.js', () => ({
  supplierRepository: {},
}));

jest.mock('../inventory/inventory.repository.js', () => ({
  inventoryRepository: {},
}));

jest.mock('../po/po.service.js', () => ({
  poService: {},
}));

jest.mock('../ai/forecastPipeline.js', () => ({
  runTextPipeline: jest.fn(),
}));

import { quotationService } from './quotation.service.js';
import { quotationRepository } from './quotation.repository.js';

describe('quotationService.submitResponse', () => {
  const tenantId = new Types.ObjectId();
  const supplierId = new Types.ObjectId();
  const itemId = new Types.ObjectId();
  const quotationId = new Types.ObjectId();
  const token = 'response-token-1234567890';

  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(quotationRepository.withScope).mockImplementation(async (_tenantId, fn) => fn());
  });

  it('accepts a public supplier response by deriving tenant scope from the token', async () => {
    jest.mocked(quotationRepository.findByTokenGlobal).mockResolvedValue({
      _id: quotationId,
      tenantId,
    } as never);
    jest.mocked(quotationRepository.findByToken).mockResolvedValue({
      _id: quotationId,
      tenantId,
      number: 'RFQ-1',
      status: 'open',
      requestedBy: new Types.ObjectId(),
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
          supplierId,
          responseToken: token,
          invitedAt: new Date('2026-08-05T10:00:00.000Z'),
          invitedContactEmail: 'sales@example.com',
          response: null,
        },
      ],
      aiRecommendation: null,
      acceptedSupplierId: null,
      acceptedAt: null,
      createdAt: new Date('2026-08-05T10:00:00.000Z'),
      updatedAt: new Date('2026-08-05T10:00:00.000Z'),
    } as never);
    jest.mocked(quotationRepository.setInvitationResponse).mockResolvedValue({
      _id: quotationId,
      tenantId,
      number: 'RFQ-1',
      status: 'open',
      requestedBy: new Types.ObjectId(),
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
          supplierId,
          responseToken: token,
          invitedAt: new Date('2026-08-05T10:00:00.000Z'),
          invitedContactEmail: 'sales@example.com',
          response: {
            submittedAt: new Date('2026-08-05T10:10:00.000Z'),
            lines: [
              {
                itemId,
                unitPrice: 235,
                currency: 'BDT',
                moq: 100,
                leadTimeDays: 12,
                validityDays: 30,
                remarks: 'FOB Chittagong',
              },
            ],
            isLate: false,
            comments: 'Stock available within 2 weeks.',
          },
        },
      ],
      aiRecommendation: null,
      acceptedSupplierId: null,
      acceptedAt: null,
      createdAt: new Date('2026-08-05T10:00:00.000Z'),
      updatedAt: new Date('2026-08-05T10:10:00.000Z'),
    } as never);

    const result = await quotationService.submitResponse(token, {
      lines: [
        {
          itemId: itemId.toString(),
          unitPrice: 235,
          currency: 'BDT',
          moq: 100,
          leadTimeDays: 12,
          validityDays: 30,
          remarks: 'FOB Chittagong',
        },
      ],
      comments: 'Stock available within 2 weeks.',
    });

    expect(quotationRepository.findByTokenGlobal).toHaveBeenCalledWith(token);
    expect(quotationRepository.withScope).toHaveBeenCalledWith(tenantId, expect.any(Function));
    expect(quotationRepository.setInvitationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        id: quotationId,
        token,
      }),
    );
    expect(result.supplierInvitations[0]?.response?.lines[0]?.unitPrice).toBe(235);
  });
});
