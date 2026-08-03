import { Types } from 'mongoose';

process.env.MONGO_URI ??= 'mongodb://localhost:27017/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= '12345678901234567890123456789012';
process.env.JWT_REFRESH_SECRET ??= '12345678901234567890123456789012';

jest.mock('../../shared/audit/index.js', () => ({
  recordAudit: jest.fn(),
  AuditActions: {},
}));

jest.mock('../../config/logger.js', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../../shared/queue/queues.js', () => ({
  enqueueForecast: jest.fn(),
  enqueueScheduled: jest.fn(),
}));

jest.mock('../../shared/storage/r2.client.js', () => ({
  tenantKey: jest.fn(),
  uploadObject: jest.fn(),
  presignGet: jest.fn(),
}));

jest.mock('../auth/models/factory.model.js', () => ({
  Factory: {
    findById: jest.fn(),
  },
}));

jest.mock('../inventory/inventory.repository.js', () => ({
  inventoryRepository: {
    findItemById: jest.fn(),
    findBalance: jest.fn(),
    findWarehouseById: jest.fn(),
  },
}));

jest.mock('../supplier/supplier.repository.js', () => ({
  supplierRepository: {
    findById: jest.fn(),
  },
}));

jest.mock('../ai/ai.repository.js', () => ({
  aiRepository: {
    findLatestForItem: jest.fn(),
  },
}));

jest.mock('./po.repository.js', () => ({
  poRepository: {},
}));

jest.mock('./po.notifications.js', () => ({
  notifyPoApproved: jest.fn(),
  notifyPoFullyReceived: jest.fn(),
  notifyPoRejected: jest.fn(),
  notifyPoSentToSupplier: jest.fn(),
  notifyPoSubmitted: jest.fn(),
}));

jest.mock('./po.pdf.js', () => ({
  renderPoPdf: jest.fn(),
}));

const { poService } = require('./po.service.js') as typeof import('./po.service.js');
const { inventoryRepository } = require('../inventory/inventory.repository.js') as typeof import('../inventory/inventory.repository.js');
const { aiRepository } = require('../ai/ai.repository.js') as typeof import('../ai/ai.repository.js');
const { supplierRepository } = require('../supplier/supplier.repository.js') as typeof import('../supplier/supplier.repository.js');

describe('poService.createFromForecast', () => {
  const tenantId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const itemId = new Types.ObjectId();
  const warehouseId = new Types.ObjectId();
  const supplierId = new Types.ObjectId();

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

  it('builds a draft PO from the latest forecast and current on-hand balance', async () => {
    jest.mocked(inventoryRepository.findItemById).mockResolvedValue({
      _id: itemId,
      tenantId,
      sku: 'COTTON-001',
      name: 'Raw Cotton',
      unit: 'kg',
      preferredSupplierId: supplierId,
      movingAverageCost: 260,
      currency: 'BDT',
      reorderLevel: 150,
    } as never);

    jest.mocked(aiRepository.findLatestForItem).mockResolvedValue({
      _id: new Types.ObjectId(),
      tenantId,
      itemId,
      horizonDays: 30,
      predictedQuantity: 1000,
      override: null,
    } as never);

    jest.mocked(inventoryRepository.findBalance).mockResolvedValue({
      _id: new Types.ObjectId(),
      tenantId,
      itemId,
      warehouseId,
      quantity: 350,
    } as never);

    jest.mocked(supplierRepository.findById).mockResolvedValue({
      _id: supplierId,
      tenantId,
      legalName: 'Supplier One',
      paymentTermsDays: 30,
      leadTimeDays: 14,
    } as never);

    const createSpy = jest.spyOn(poService, 'create').mockResolvedValue({
      id: new Types.ObjectId().toString(),
      supplierId: supplierId.toString(),
      warehouseId: warehouseId.toString(),
      lines: [],
    } as never);

    await poService.createFromForecast({
      ctx,
      itemId,
      warehouseId,
    });

    expect(createSpy).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        supplierId: supplierId.toString(),
        warehouseId: warehouseId.toString(),
        currency: 'BDT',
        paymentTermsDays: 30,
        lines: [
          expect.objectContaining({
            itemId: itemId.toString(),
            quantityOrdered: 650,
            unitPrice: 260,
          }),
        ],
      }),
    );
  });
});
