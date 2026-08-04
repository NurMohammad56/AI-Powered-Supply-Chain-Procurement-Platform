import { Types } from 'mongoose';

process.env.MONGO_URI ??= 'mongodb://localhost:27017/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= '12345678901234567890123456789012';
process.env.JWT_REFRESH_SECRET ??= '12345678901234567890123456789012';

jest.mock('../../shared/audit/index.js', () => ({
  recordAudit: jest.fn(),
  AuditActions: {
    QuoteAccepted: 'quote.accepted',
  },
}));

jest.mock('../../shared/queue/queues.js', () => ({
  enqueueForecast: jest.fn(),
  enqueueScheduled: jest.fn(),
}));

jest.mock('../../config/logger.js', () => ({
  logger: {
    warn: jest.fn(),
  },
}));

jest.mock('./quotation.repository.js', () => ({
  quotationRepository: {
    findById: jest.fn(),
    accept: jest.fn(),
  },
}));

jest.mock('./supplier.repository.js', () => ({
  supplierRepository: {
    findById: jest.fn(),
  },
}));

jest.mock('../inventory/inventory.repository.js', () => ({
  inventoryRepository: {
    findItemById: jest.fn(),
    listBalancesForItem: jest.fn(),
    findWarehouseById: jest.fn(),
    listWarehouses: jest.fn(),
  },
}));

jest.mock('../po/po.service.js', () => ({
  poService: {
    create: jest.fn(),
  },
}));

import { quotationService } from './quotation.service.js';
import { quotationRepository } from './quotation.repository.js';
import { supplierRepository } from './supplier.repository.js';
import { inventoryRepository } from '../inventory/inventory.repository.js';
import { poService } from '../po/po.service.js';

describe('quotationService.accept', () => {
  const tenantId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const supplierId = new Types.ObjectId();
  const itemId = new Types.ObjectId();
  const warehouseId = new Types.ObjectId();
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

  it('creates a draft PO with the first active tenant warehouse when warehouseId is omitted', async () => {
    const acceptedAt = new Date('2026-08-02T10:00:00.000Z');
    const quotation = {
      _id: quotationId,
      tenantId,
      number: 'RFQ-1',
      status: 'open',
      requestedBy: userId,
      validUntil: new Date('2026-08-10T00:00:00.000Z'),
      lines: [{ itemId, quantity: 100, targetUnitPrice: null, targetDeliveryDate: null, remarks: null }],
      supplierInvitations: [
        {
          supplierId,
          invitedAt: new Date('2026-08-01T00:00:00.000Z'),
          invitedContactEmail: 'sales@example.com',
          responseToken: 'token-1',
          response: {
            submittedAt: new Date('2026-08-01T12:00:00.000Z'),
            isLate: false,
            comments: null,
            lines: [
              {
                itemId,
                unitPrice: 250,
                currency: 'BDT',
                moq: 10,
                leadTimeDays: 7,
                validityDays: 30,
                remarks: null,
              },
            ],
          },
        },
      ],
      aiRecommendation: null,
      acceptedSupplierId: null,
      acceptedAt: null,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    const acceptedQuotation = {
      ...quotation,
      status: 'closed',
      acceptedSupplierId: supplierId,
      acceptedAt,
    };

    jest.mocked(quotationRepository.findById).mockResolvedValue(quotation as never);
    jest.mocked(quotationRepository.accept).mockResolvedValue(acceptedQuotation as never);
    jest.mocked(inventoryRepository.findItemById).mockResolvedValue({
      _id: itemId,
      tenantId,
      sku: 'SKU-1',
      name: 'Cotton',
      unit: 'kg',
      preferredSupplierId: supplierId,
    } as never);
    jest.mocked(inventoryRepository.listBalancesForItem).mockResolvedValue([] as never);
    jest.mocked(inventoryRepository.listWarehouses).mockResolvedValue({
      rows: [
        {
          _id: warehouseId,
          tenantId,
          isActive: true,
          name: 'Main Warehouse',
          code: 'WH1',
        },
      ],
      nextCursor: null,
      hasMore: false,
      limit: 1,
    } as never);
    jest.mocked(supplierRepository.findById).mockResolvedValue({
      _id: supplierId,
      tenantId,
      legalName: 'Supplier One',
      paymentTermsDays: 30,
      leadTimeDays: 14,
    } as never);
    jest.mocked(poService.create).mockResolvedValue({
      id: new Types.ObjectId().toString(),
      warehouseId: warehouseId.toString(),
    } as never);

    const result = await quotationService.accept(ctx, quotationId, {
      supplierId: supplierId.toString(),
    });

    expect(poService.create).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        supplierId: supplierId.toString(),
        warehouseId: warehouseId.toString(),
        currency: 'BDT',
      }),
    );
    expect(result.purchaseOrder).not.toBeNull();
  });

  it('uses the explicit warehouseId when the client provides one', async () => {
    const quotation = {
      _id: quotationId,
      tenantId,
      number: 'RFQ-2',
      status: 'open',
      requestedBy: userId,
      validUntil: new Date('2026-08-10T00:00:00.000Z'),
      lines: [{ itemId, quantity: 50, targetUnitPrice: null, targetDeliveryDate: null, remarks: null }],
      supplierInvitations: [
        {
          supplierId,
          invitedAt: new Date('2026-08-01T00:00:00.000Z'),
          invitedContactEmail: 'sales@example.com',
          responseToken: 'token-2',
          response: {
            submittedAt: new Date('2026-08-01T12:00:00.000Z'),
            isLate: false,
            comments: null,
            lines: [
              {
                itemId,
                unitPrice: 200,
                currency: 'USD',
                moq: 5,
                leadTimeDays: 5,
                validityDays: 20,
                remarks: null,
              },
            ],
          },
        },
      ],
      aiRecommendation: null,
      acceptedSupplierId: null,
      acceptedAt: null,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    const acceptedQuotation = {
      ...quotation,
      status: 'closed',
      acceptedSupplierId: supplierId,
      acceptedAt: new Date('2026-08-02T10:00:00.000Z'),
    };

    jest.mocked(quotationRepository.findById).mockResolvedValue(quotation as never);
    jest.mocked(quotationRepository.accept).mockResolvedValue(acceptedQuotation as never);
    jest.mocked(inventoryRepository.findItemById).mockResolvedValue({
      _id: itemId,
      tenantId,
      sku: 'SKU-2',
      name: 'Yarn',
      unit: 'kg',
      preferredSupplierId: null,
    } as never);
    jest.mocked(inventoryRepository.findWarehouseById).mockResolvedValue({
      _id: warehouseId,
      tenantId,
      isActive: true,
      name: 'Explicit Warehouse',
      code: 'WH2',
    } as never);
    jest.mocked(supplierRepository.findById).mockResolvedValue({
      _id: supplierId,
      tenantId,
      legalName: 'Supplier Two',
      paymentTermsDays: 45,
      leadTimeDays: 21,
    } as never);
    jest.mocked(poService.create).mockResolvedValue({
      id: new Types.ObjectId().toString(),
      warehouseId: warehouseId.toString(),
    } as never);

    await quotationService.accept(ctx, quotationId, {
      supplierId: supplierId.toString(),
      warehouseId: warehouseId.toString(),
    });

    expect(inventoryRepository.findWarehouseById).toHaveBeenCalledWith(warehouseId.toString());
    expect(poService.create).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        warehouseId: warehouseId.toString(),
        currency: 'USD',
      }),
    );
  });
});
