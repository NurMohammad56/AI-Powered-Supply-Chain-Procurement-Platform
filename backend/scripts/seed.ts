import { Types } from 'mongoose';

import { connectDatabase, disconnectDatabase, mongoose } from '../src/config/database.js';
import { logger } from '../src/config/logger.js';
import { tenantStorage } from '../src/shared/db/tenancyPlugin.js';
import { Factory } from '../src/modules/auth/models/factory.model.js';
import { Supplier } from '../src/modules/supplier/models/supplier.model.js';
import { ItemCategory } from '../src/modules/inventory/models/itemCategory.model.js';
import { Warehouse } from '../src/modules/inventory/models/warehouse.model.js';
import { Item } from '../src/modules/inventory/models/item.model.js';
import { StockBalance } from '../src/modules/inventory/models/stockBalance.model.js';
import { StockMovement } from '../src/modules/inventory/models/stockMovement.model.js';
import { PurchaseOrder } from '../src/modules/po/models/purchaseOrder.model.js';

const tenantId = new Types.ObjectId('6a5f33bb7a8ace9eb1fa3d3c');
const performedBy = new Types.ObjectId('6a5f33bc7a8ace9eb1fa3d3e');
const supplierAId = new Types.ObjectId('6a62fa63ce6e473f277f7313');
const supplierBId = new Types.ObjectId('6a62faa4ce6e473f277f7318');

const reportItemSku = 'REPORT-COTTON-001';
const deadStockSku = 'REPORT-DEAD-001';
const warehouseCode = 'WH-REPORT';

function withTenantScope<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    tenantStorage.run({ tenantId }, () => {
      fn().then(resolve, reject);
    });
  });
}

async function ensureFactory(): Promise<void> {
  const exists = await Factory.findById(tenantId).lean().exec();
  if (exists) return;
  await Factory.create({
    _id: tenantId,
    name: 'Seed Factory',
    slug: 'seed-factory',
    businessType: 'rmg',
    country: 'BD',
    timeZone: 'Asia/Dhaka',
    baseCurrency: 'BDT',
    branding: { logoUrl: null, primaryColor: '#1E40AF' },
    ownerUserId: null,
    status: 'active',
  });
}

async function ensureSupplier(input: {
  _id: Types.ObjectId;
  legalName: string;
  tradingName: string | null;
  email: string;
}): Promise<void> {
  const exists = await withTenantScope(() => Supplier.findById(input._id).lean().exec());
  if (exists) return;
  await withTenantScope(() =>
    Supplier.create({
      _id: input._id,
      legalName: input.legalName,
      tradingName: input.tradingName,
      taxId: null,
      status: 'active',
      address: {
        street: 'Seed Address',
        city: 'Dhaka',
        country: 'BD',
        postalCode: '1000',
      },
      paymentTermsDays: 30,
      leadTimeDays: 14,
      contacts: [
        {
          name: 'Sales',
          designation: 'Sales Manager',
          email: input.email,
          phone: null,
          isPrimary: true,
        },
      ],
      categoryIds: [],
      tier: 'preferred',
      performanceScore: {
        overall: 78,
        onTimeDeliveryRate: 0.92,
        qualityRejectRate: 0.01,
        priceCompetitiveness: 76,
        sampleSize: 12,
        computedAt: new Date(),
      },
      documentUrls: [],
      archivedAt: null,
    }),
  );
}

async function ensureCategory(name: string): Promise<{ _id: Types.ObjectId }> {
  const existing = await withTenantScope(() => ItemCategory.findOne({ name }).lean().exec());
  if (existing) return existing;
  const created = await withTenantScope(() =>
    ItemCategory.create({
      name,
      parentId: null,
      description: null,
      archivedAt: null,
    }),
  );
  return created.toObject();
}

async function ensureWarehouse(): Promise<{ _id: Types.ObjectId; name: string; code: string }> {
  const existing = await withTenantScope(() => Warehouse.findOne({ code: warehouseCode }).lean().exec());
  if (existing) return existing;
  const created = await withTenantScope(() =>
    Warehouse.create({
      name: 'Reporting Warehouse',
      code: warehouseCode,
      address: {
        street: 'Plot 1',
        city: 'Dhaka',
        country: 'BD',
        postalCode: '1207',
      },
      isActive: true,
      archivedAt: null,
    }),
  );
  return created.toObject();
}

async function ensureItem(input: {
  sku: string;
  name: string;
  categoryId: Types.ObjectId | null;
  preferredSupplierId: Types.ObjectId | null;
  reorderLevel: number;
  movingAverageCost: number;
}): Promise<{ _id: Types.ObjectId; sku: string; name: string; unit: string }> {
  const existing = await withTenantScope(() => Item.findOne({ sku: input.sku }).lean().exec());
  if (existing) return existing;
  const created = await withTenantScope(() =>
    Item.create({
      sku: input.sku,
      barcode: null,
      name: input.name,
      description: null,
      categoryId: input.categoryId,
      unit: 'kg',
      type: 'raw_material',
      preferredSupplierId: input.preferredSupplierId,
      reorderLevel: input.reorderLevel,
      movingAverageCost: input.movingAverageCost,
      currency: 'BDT',
      archivedAt: null,
    }),
  );
  return created.toObject();
}

async function ensureStockBalance(args: {
  itemId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  quantity: number;
  lastMovementAt: Date;
}): Promise<void> {
  const existing = await withTenantScope(() =>
    StockBalance.findOne({ itemId: args.itemId, warehouseId: args.warehouseId }).lean().exec(),
  );
  if (existing) {
    await withTenantScope(() =>
      StockBalance.updateOne(
        { _id: existing._id },
        {
          $set: {
            quantity: args.quantity,
            lastMovementAt: args.lastMovementAt,
            reservedQuantity: 0,
            reorderLevelOverride: null,
            lowStockSince: null,
          },
        },
      ).exec(),
    );
    return;
  }
  await withTenantScope(() =>
    StockBalance.create({
      itemId: args.itemId,
      warehouseId: args.warehouseId,
      quantity: args.quantity,
      reservedQuantity: 0,
      reorderLevelOverride: null,
      lastMovementAt: args.lastMovementAt,
      lowStockSince: null,
      version: 0,
    }),
  );
}

async function ensureMovement(input: {
  refId: Types.ObjectId;
  itemId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  type: 'out' | 'transfer_out' | 'adjustment';
  quantity: number;
  reasonCode: string;
  performedAt: Date;
}): Promise<void> {
  const existing = await withTenantScope(() =>
    StockMovement.findOne({ 'reference.id': input.refId }).lean().exec(),
  );
  if (existing) return;
  await withTenantScope(() =>
    StockMovement.create({
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      type: input.type,
      quantity: input.quantity,
      unitCost: null,
      reasonCode: input.reasonCode,
      reference: { kind: 'manual', id: input.refId },
      attachmentUrl: null,
      performedBy,
      performedAt: input.performedAt,
    }),
  );
}

async function ensurePurchaseOrder(input: {
  number: string;
  supplierId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  item: { _id: Types.ObjectId; sku: string; name: string; unit: string };
  supplierName: string;
  supplierEmail: string;
  state: 'sent' | 'partially_received';
  currency: 'BDT' | 'USD';
  paymentTermsDays: number;
  expectedDeliveryAt: Date;
  quantityOrdered: number;
  quantityReceived: number;
  unitPrice: number;
}): Promise<void> {
  const existing = await withTenantScope(() =>
    PurchaseOrder.findOne({ number: input.number }).lean().exec(),
  );
  if (existing) return;
  const subtotal = Math.round(input.quantityOrdered * input.unitPrice * 100) / 100;
  await withTenantScope(() =>
    PurchaseOrder.create({
      number: input.number,
      state: input.state,
      supplierId: input.supplierId,
      supplierSnapshot: {
        legalName: input.supplierName,
        address: null,
        primaryContactEmail: input.supplierEmail,
      },
      warehouseId: input.warehouseId,
      currency: input.currency,
      paymentTermsDays: input.paymentTermsDays,
      expectedDeliveryAt: input.expectedDeliveryAt,
      lines: [
        {
          itemId: input.item._id,
          itemSnapshot: {
            sku: input.item.sku,
            name: input.item.name,
            unit: input.item.unit,
          },
          quantityOrdered: input.quantityOrdered,
          quantityReceived: input.quantityReceived,
          unitPrice: input.unitPrice,
          lineTotal: subtotal,
          expectedDeliveryAt: input.expectedDeliveryAt,
          remarks: 'Seeded report PO',
        },
      ],
      totals: {
        subtotal,
        tax: 0,
        total: subtotal,
      },
      pdfUrl: null,
      pdfGeneratedAt: null,
      approval: {
        submittedAt: new Date(),
        submittedBy: performedBy,
        decidedAt: new Date(),
        decidedBy: performedBy,
        decision: 'approved',
        rejectReason: null,
        thresholdRule: 'seed',
      },
      dispatch: {
        sentAt: new Date(),
        sentTo: input.supplierEmail,
        emailDeliveryId: null,
      },
      cancellation: null,
      revisions: [],
      createdBy: performedBy,
      approvedAt: new Date(),
      closedAt: input.state === 'partially_received' ? null : new Date(),
    }),
  );
}

async function main(): Promise<void> {
  await connectDatabase();
  await ensureFactory();

  const turnoverCategory = await ensureCategory('Seed Raw Materials');
  const deadStockCategory = await ensureCategory('Seed Dead Stock');
  const warehouse = await ensureWarehouse();

  await ensureSupplier({
    _id: supplierAId,
    legalName: 'Bengal Cotton Traders Ltd.',
    tradingName: 'Bengal Cotton Traders',
    email: 'sales1@example.com',
  });
  await ensureSupplier({
    _id: supplierBId,
    legalName: 'Bengal Cotton Traders Ltd. 2',
    tradingName: 'Bengal Cotton Traders 2',
    email: 'sales2@example.com',
  });

  const turnoverItem = await ensureItem({
    sku: reportItemSku,
    name: 'Reporting Cotton 60 GSM',
    categoryId: turnoverCategory._id,
    preferredSupplierId: supplierBId,
    reorderLevel: 100,
    movingAverageCost: 235,
  });
  const deadStockItem = await ensureItem({
    sku: deadStockSku,
    name: 'Dead Stock Fabric Roll',
    categoryId: deadStockCategory._id,
    preferredSupplierId: null,
    reorderLevel: 50,
    movingAverageCost: 180,
  });

  await ensureStockBalance({
    itemId: turnoverItem._id,
    warehouseId: warehouse._id,
    quantity: 1200,
    lastMovementAt: new Date('2026-08-14T10:00:00.000Z'),
  });
  await ensureStockBalance({
    itemId: deadStockItem._id,
    warehouseId: warehouse._id,
    quantity: 400,
    lastMovementAt: new Date('2026-07-01T10:00:00.000Z'),
  });

  await ensureMovement({
    refId: new Types.ObjectId('66b0a0000000000000000001'),
    itemId: turnoverItem._id,
    warehouseId: warehouse._id,
    type: 'out',
    quantity: -140,
    reasonCode: 'production_consume',
    performedAt: new Date('2026-07-20T09:00:00.000Z'),
  });
  await ensureMovement({
    refId: new Types.ObjectId('66b0a0000000000000000002'),
    itemId: turnoverItem._id,
    warehouseId: warehouse._id,
    type: 'out',
    quantity: -120,
    reasonCode: 'production_consume',
    performedAt: new Date('2026-07-25T09:00:00.000Z'),
  });
  await ensureMovement({
    refId: new Types.ObjectId('66b0a0000000000000000003'),
    itemId: turnoverItem._id,
    warehouseId: warehouse._id,
    type: 'transfer_out',
    quantity: -90,
    reasonCode: 'transfer',
    performedAt: new Date('2026-08-02T09:00:00.000Z'),
  });
  await ensureMovement({
    refId: new Types.ObjectId('66b0a0000000000000000004'),
    itemId: turnoverItem._id,
    warehouseId: warehouse._id,
    type: 'adjustment',
    quantity: -60,
    reasonCode: 'count_correction',
    performedAt: new Date('2026-08-10T09:00:00.000Z'),
  });

  await ensurePurchaseOrder({
    number: 'PO-RPT-001',
    supplierId: supplierBId,
    warehouseId: warehouse._id,
    item: turnoverItem,
    supplierName: 'Bengal Cotton Traders Ltd. 2',
    supplierEmail: 'sales2@example.com',
    state: 'sent',
    currency: 'BDT',
    paymentTermsDays: 30,
    expectedDeliveryAt: new Date('2026-08-25T00:00:00.000Z'),
    quantityOrdered: 600,
    quantityReceived: 0,
    unitPrice: 235,
  });
  await ensurePurchaseOrder({
    number: 'PO-RPT-002',
    supplierId: supplierAId,
    warehouseId: warehouse._id,
    item: turnoverItem,
    supplierName: 'Bengal Cotton Traders Ltd.',
    supplierEmail: 'sales1@example.com',
    state: 'partially_received',
    currency: 'BDT',
    paymentTermsDays: 45,
    expectedDeliveryAt: new Date('2026-08-30T00:00:00.000Z'),
    quantityOrdered: 600,
    quantityReceived: 250,
    unitPrice: 200,
  });

  logger.info(
    {
      event: 'seed.report_data_complete',
      tenantId: tenantId.toString(),
      warehouseId: warehouse._id.toString(),
      turnoverItemId: turnoverItem._id.toString(),
      deadStockItemId: deadStockItem._id.toString(),
      supplierAId: supplierAId.toString(),
      supplierBId: supplierBId.toString(),
      readyState: mongoose.connection.readyState,
    },
    'seed data created',
  );
}

main()
  .catch((err: unknown) => {
    logger.error({ err, event: 'seed.report_data_failed' }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDatabase().catch(() => undefined);
  });
