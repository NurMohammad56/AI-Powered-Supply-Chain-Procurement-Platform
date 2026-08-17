import { Types } from 'mongoose';

import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { logger } from '../src/config/logger.js';
import { tenantStorage } from '../src/shared/db/tenancyPlugin.js';
import { Factory } from '../src/modules/auth/models/factory.model.js';
import { User } from '../src/modules/auth/models/user.model.js';
import { PurchaseOrder } from '../src/modules/po/models/purchaseOrder.model.js';
import { StockBalance } from '../src/modules/inventory/models/stockBalance.model.js';
import { Item } from '../src/modules/inventory/models/item.model.js';
import { Notification } from '../src/modules/notification/models/notification.model.js';

async function withTenantScope<T>(tenantId: Types.ObjectId, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    tenantStorage.run({ tenantId }, () => {
      fn().then(resolve, reject);
    });
  });
}

async function ensureNotification(input: {
  tenantId: Types.ObjectId;
  userId: Types.ObjectId;
  category: 'low_stock' | 'po_status' | 'delivery_reminder' | 'weekly_digest' | 'system';
  title: string;
  body: string;
  link: string | null;
  kind: string;
  refId: string;
  extra?: Record<string, unknown>;
}): Promise<boolean> {
  return withTenantScope(input.tenantId, async () => {
    const existing = await Notification.findOne({
      userId: input.userId,
      category: input.category,
      title: input.title,
      'metadata.kind': input.kind,
      'metadata.refId': input.refId,
    })
      .lean()
      .exec();
    if (existing) return false;

    await Notification.create({
      userId: input.userId,
      category: input.category,
      title: input.title,
      body: input.body,
      link: input.link,
      metadata: {
        kind: input.kind,
        refId: input.refId,
        ...(input.extra ?? {}),
      },
      readAt: null,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });
    return true;
  });
}

async function seedTenant(tenantId: Types.ObjectId): Promise<{ created: number; skipped: number }> {
  const owner = await withTenantScope(tenantId, () =>
    User.findOne({ role: 'owner', status: 'active' }).sort({ createdAt: 1 }).lean().exec(),
  );
  if (!owner) return { created: 0, skipped: 0 };

  const activeUsers = await withTenantScope(tenantId, () =>
    User.find({ status: 'active', role: { $in: ['owner', 'manager'] } })
      .select({ _id: 1, fullName: 1, email: 1, role: 1 })
      .lean<Array<{ _id: Types.ObjectId; fullName: string; email: string; role: string }>>()
      .exec(),
  );

  const pOs = await withTenantScope(tenantId, () =>
    PurchaseOrder.find({}).sort({ createdAt: -1 }).limit(8).lean().exec(),
  );
  const balances = await withTenantScope(tenantId, () =>
    StockBalance.find({ quantity: { $lte: 0 } })
      .sort({ updatedAt: -1 })
      .limit(8)
      .lean()
      .exec(),
  );

  const itemIds = [
    ...new Set(
      balances.map((b) => b.itemId.toString()).filter(Boolean),
    ),
  ].map((id) => new Types.ObjectId(id));
  const items = await withTenantScope(tenantId, async () => {
    if (itemIds.length === 0) return [] as Awaited<ReturnType<typeof Item.find>>;
    return Item.find({ _id: { $in: itemIds } }).lean().exec();
  });
  const itemById = new Map(items.map((item) => [item._id.toString(), item]));

  let created = 0;
  let skipped = 0;

  for (const po of pOs) {
    const recipientId = po.createdBy ?? owner._id;
    const body = `Purchase order ${po.number} is currently ${po.state} with total ${po.currency} ${po.totals.total}.`;
    const ok = await ensureNotification({
      tenantId,
      userId: recipientId,
      category: 'po_status',
      title: `PO ${po.number} status: ${po.state}`,
      body,
      link: null,
      kind: 'seed_po_status',
      refId: po._id.toString(),
      extra: { poId: po._id.toString(), state: po.state, supplierId: po.supplierId.toString() },
    });
    if (ok) created += 1;
    else skipped += 1;
  }

  for (const balance of balances) {
    const item = itemById.get(balance.itemId.toString());
    const title = `Low stock: ${item?.name ?? balance.itemId.toString()}`;
    const body = `Item ${item?.sku ?? balance.itemId.toString()} has quantity ${balance.quantity}.`;
    const ok = await ensureNotification({
      tenantId,
      userId: owner._id,
      category: 'low_stock',
      title,
      body,
      link: null,
      kind: 'seed_low_stock',
      refId: `${balance.itemId.toString()}_${balance.warehouseId.toString()}`,
      extra: {
        itemId: balance.itemId.toString(),
        warehouseId: balance.warehouseId.toString(),
        quantity: balance.quantity,
      },
    });
    if (ok) created += 1;
    else skipped += 1;
  }

  for (const user of activeUsers) {
    const ok = await ensureNotification({
      tenantId,
      userId: user._id,
      category: 'system',
      title: 'Notification feed seeded',
      body: `Seeded notifications were created from existing purchase orders and stock balances for ${user.role}.`,
      link: null,
      kind: 'seed_summary',
      refId: user._id.toString(),
      extra: { userRole: user.role, email: user.email },
    });
    if (ok) created += 1;
    else skipped += 1;
  }

  return { created, skipped };
}

async function main(): Promise<void> {
  await connectDatabase();

  const factories = await Factory.find({}).lean().exec();
  let created = 0;
  let skipped = 0;
  for (const factory of factories) {
    const result = await seedTenant(factory._id);
    created += result.created;
    skipped += result.skipped;
  }

  logger.info(
    {
      event: 'seed.notifications_complete',
      tenantCount: factories.length,
      created,
      skipped,
    },
    'notification seed complete',
  );
}

main()
  .catch((err: unknown) => {
    logger.error({ err, event: 'seed.notifications_failed' }, 'notification seed failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDatabase().catch(() => undefined);
  });
