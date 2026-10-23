import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { mongoose } from '../../config/database.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { redisCache } from '../../config/redis.js';
import { tenantStorage } from '../../shared/db/tenancyPlugin.js';
import { enqueueEmail, enqueueForecast } from '../../shared/queue/queues.js';
import { getIo } from '../../shared/realtime/socketServer.js';
import { SocketEvents, userRoom } from '../../shared/realtime/events.js';
import { Factory } from '../auth/models/factory.model.js';
import { User } from '../auth/models/user.model.js';
import { Subscription } from '../billing/models/subscription.model.js';
import { checkQuota } from '../ai/aiUsage.repository.js';
import { Forecast } from '../ai/models/forecast.model.js';
import { Notification } from '../notification/models/notification.model.js';
import { inventoryRepository } from './inventory.repository.js';
import { StockBalance, type StockBalanceDoc } from './models/stockBalance.model.js';

const SIX_HOURS = 6 * 3600_000;
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/** Tenant-scoped, durable pending markers survive API/Redis/worker outages. */
export async function processTenantLowStock(tenantId: Types.ObjectId): Promise<void> {
  await tenantStorage.run({ tenantId }, async () => {
    // Reconcile legacy balances and changed thresholds, with bounded memory.
    for await (const row of StockBalance.find().sort({ _id: 1 }).cursor()) {
      try {
        await mongoose.connection.transaction(async () => {
          const current = await StockBalance.findById(row._id).lean().exec();
          if (current) await inventoryRepository.reconcileLowStock(current);
        });
      } catch (err) {
        logger.warn(
          { err, event: 'low_stock.reconcile_failed', balanceId: row._id },
          'Low-stock reconciliation will retry',
        );
      }
    }
    const now = new Date();
    for await (const row of StockBalance.find({
      lowStockSince: { $type: 'date' },
      $or: [
        { lowStockNotifiedAt: null },
        { lowStockNextForecastAt: null },
        { lowStockNextForecastAt: { $lte: now } },
      ],
    })
      .sort({ _id: 1 })
      .cursor()) {
      try {
        await processBalanceLowStock(row.toObject());
      } catch (err) {
        // Leave pending fields intact. One tenant/item failure must not starve others.
        logger.warn(
          { err, event: 'low_stock.delivery_failed', balanceId: row._id },
          'Low-stock automation will retry',
        );
      }
    }
  });
}

export async function runLowStockMonitor(): Promise<void> {
  const configured = env.LOW_STOCK_MONITOR_TENANT_IDS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (configured.some((id) => !Types.ObjectId.isValid(id)))
    throw new Error('Invalid low-stock monitor tenant ID');
  for await (const factory of Factory.find({
    status: { $in: ['active', 'trial'] },
    ...(configured.length ? { _id: { $in: configured.map((id) => new Types.ObjectId(id)) } } : {}),
  })
    .select({ _id: 1 })
    .cursor()) {
    await processTenantLowStock(factory._id);
  }
}

async function processBalanceLowStock(balance: StockBalanceDoc): Promise<void> {
  const episode = balance.lowStockEpisodeId;
  if (!episode) return;
  const item = await inventoryRepository.findItemById(balance.itemId);
  const warehouse = await inventoryRepository.findWarehouseById(balance.warehouseId);
  if (!item || !warehouse?.isActive) return;
  const recipients = await User.find({
    role: { $in: ['owner', 'manager', 'warehouse_staff'] },
    status: 'active',
  })
    .sort({ _id: 1 })
    .lean()
    .exec();
  const filter = { _id: balance._id, lowStockEpisodeId: episode };
  const threshold = balance.reorderLevelOverride ?? item.reorderLevel;
  const link = `${env.FRONTEND_BASE_URL}/inventory/items/${item._id.toString()}`;
  const title = `Low stock: ${item.sku}`.slice(0, 200);
  const text = `${item.name} at ${warehouse.name}: ${balance.quantity} ${item.unit} available; reorder level ${threshold} ${item.unit}.`;

  if (!balance.lowStockNotifiedAt) {
    for (const user of recipients) {
      const id = new Types.ObjectId(
        createHash('sha256').update(`${episode}-${user._id}`).digest('hex').slice(0, 24),
      );
      const prefs = user.notificationPrefs?.lowStock;
      if (prefs?.inApp !== false) {
        // Stable ID provides deduplication even after a worker crash/retry.
        const result = await Notification.updateOne(
          { _id: id },
          {
            $setOnInsert: {
              userId: user._id,
              category: 'low_stock',
              title,
              body: text,
              link,
              metadata: {
                episodeId: episode.toString(),
                itemId: item._id.toString(),
                warehouseId: warehouse._id.toString(),
                resolvedAt: null,
              },
              readAt: null,
              expiresAt: new Date(Date.now() + 90 * 86400_000),
            },
          },
          { upsert: true },
        ).exec();
        if (result.upsertedCount) {
          try {
            getIo().to(userRoom(user._id.toString())).emit(SocketEvents.NotificationCreated, {
              notificationId: id.toString(),
              category: 'low_stock',
              title,
              link,
              createdAt: new Date().toISOString(),
            });
          } catch {
            /* The persisted feed works without a socket client. */
          }
        }
      }
      if (prefs?.email !== false) {
        await enqueueEmail(
          'email.send',
          {
            tenantId: balance.tenantId.toString(),
            to: user.email,
            subject: title,
            text,
            html: `<p>${escapeHtml(text)}</p><p><a href="${escapeHtml(link)}">Review stock</a></p>`,
            template: 'inventory.low_stock',
            tags: { kind: 'low_stock', episodeId: episode.toString() },
            lowStockBalanceId: balance._id.toString(),
            lowStockEpisodeId: episode.toString(),
          },
          {
            jobId: `ls-${id}`,
            removeOnComplete: { age: 7 * 86400 },
            removeOnFail: { age: 30 * 86400 },
          },
        );
      }
    }
    await StockBalance.updateOne(filter, { $set: { lowStockNotifiedAt: new Date() } }).exec();
  }

  if (balance.lowStockNextForecastAt && balance.lowStockNextForecastAt.getTime() > Date.now())
    return;
  const next = (delay: number) =>
    StockBalance.updateOne(filter, {
      $set: { lowStockNextForecastAt: new Date(Date.now() + delay) },
    }).exec();
  if (!env.LOW_STOCK_AI_ENABLED) {
    await next(3600_000);
    return;
  }
  const actor =
    recipients.find((u) => u.role === 'owner') ?? recipients.find((u) => u.role === 'manager');
  if (!actor) {
    await next(3600_000);
    return;
  }
  const recent = await Forecast.findOne({ itemId: item._id, horizonDays: 30 })
    .sort({ generatedAt: -1 })
    .lean()
    .exec();
  if (recent && recent.generatedAt.getTime() > Date.now() - SIX_HOURS) {
    await next(
      Math.max(
        SIX_HOURS,
        recent.generatedAt.getTime() + env.LOW_STOCK_AI_INTERVAL_HOURS * 3600_000 - Date.now(),
      ),
    );
    return;
  }
  const subscription = await Subscription.findOne().lean().exec();
  const quota = await checkQuota({
    tenantId: balance.tenantId,
    tier: subscription?.tier ?? 'trial',
    callKind: 'forecast',
    estimatedTokens: 1500,
  });
  if (!quota.allowed) {
    logger.warn(
      { event: 'low_stock.ai_quota_skipped', tenantId: balance.tenantId, itemId: item._id },
      'Low-stock alert delivered; AI quota unavailable',
    );
    await next(SIX_HOURS);
    return;
  }
  // Bound automatic queue fan-out to ten item jobs per minute per tenant.
  const window = Math.floor(Date.now() / 60_000);
  const key = `${env.QUEUE_PREFIX}:low-stock-ai:${balance.tenantId}:${window}`;
  const count = Number(
    await redisCache.eval(
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],120) end; return n",
      1,
      key,
    ),
  );
  if (count > 10) {
    await next(60_000);
    return;
  }
  await enqueueForecast(
    'forecast.single_item',
    {
      tenantId: balance.tenantId.toString(),
      itemId: item._id.toString(),
      requestedBy: actor._id.toString(),
      lowStockBalanceId: balance._id.toString(),
      lowStockEpisodeId: episode.toString(),
    },
    { jobId: `low-stock-ai-${episode}-${Math.floor(Date.now() / SIX_HOURS)}` },
  );
  await next(env.LOW_STOCK_AI_INTERVAL_HOURS * 3600_000);
}
