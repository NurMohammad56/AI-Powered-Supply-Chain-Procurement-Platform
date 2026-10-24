import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { SMTPServer } from 'smtp-server';
import { Types } from 'mongoose';
import { createApp } from '../src/app.js';
import { connectDatabase, disconnectDatabase, mongoose } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { connectRedis, disconnectRedis, redisCache } from '../src/config/redis.js';
import { tenantStorage } from '../src/shared/db/tenancyPlugin.js';
import {
  closeQueues,
  emailQueue,
  forecastQueue,
  scheduledQueue,
} from '../src/shared/queue/queues.js';
import { startEmailWorker } from '../src/workers/email.worker.js';
import { startForecastWorker } from '../src/workers/forecast.worker.js';
import { startScheduledWorker } from '../src/workers/scheduled.worker.js';
import { processTenantLowStock } from '../src/modules/inventory/lowStock.automation.js';
import { User } from '../src/modules/auth/models/user.model.js';
import { StockBalance } from '../src/modules/inventory/models/stockBalance.model.js';
import { StockMovement } from '../src/modules/inventory/models/stockMovement.model.js';
import { Notification } from '../src/modules/notification/models/notification.model.js';
import { EmailDelivery } from '../src/modules/notification/models/emailDelivery.model.js';
import { Forecast } from '../src/modules/ai/models/forecast.model.js';
import { AiUsage, periodKey } from '../src/modules/ai/models/aiUsage.model.js';
import { Subscription } from '../src/modules/billing/models/subscription.model.js';
import { Item } from '../src/modules/inventory/models/item.model.js';

// Real dependencies, isolated queue prefix and new synthetic factory per run.
assert.match(env.QUEUE_PREFIX, /^low-stock-qa-/);
assert.equal(env.SMTP_HOST, '127.0.0.1');
assert.equal(env.SMTP_PORT, 2527);
const checks: Array<{ name: string; pass: boolean }> = [];
const suffix = Date.now().toString(36);
const password = 'LowStockReal!2026';
let tenantId: Types.ObjectId;
let base = '',
  owner = '',
  warehouseId = '',
  itemId = '';
const tokens: Record<string, string> = {};
const userIds: Record<string, string> = {};
const scope = <T>(fn: () => Promise<T>) => tenantStorage.run({ tenantId }, fn);
const pass = (name: string, value: unknown) => {
  assert.ok(value, name);
  checks.push({ name, pass: true });
  console.log(`PASS ${name}`);
};
async function call(
  method: string,
  path: string,
  body?: unknown,
  token = owner,
  expected = 200,
  key = randomUUID(),
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = response.status === 204 ? {} : ((await response.json()) as any);
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload.data;
}
async function waitFor<T>(
  name: string,
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 120_000,
): Promise<T> {
  const end = Date.now() + timeout;
  do {
    const value = await read();
    if (predicate(value)) {
      pass(name, true);
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < end);
  throw new Error(`Timeout: ${name}`);
}
const balance = () => scope(() => StockBalance.findOne({ itemId, warehouseId }).lean().exec());
const alerts = () =>
  scope(() =>
    Notification.find({ category: 'low_stock', 'metadata.itemId': itemId }).lean().exec(),
  );
const deliveries = () =>
  scope(() =>
    EmailDelivery.find({
      template: 'inventory.low_stock',
      subject: `Low stock: LS-${suffix.toUpperCase()}`,
    })
      .lean()
      .exec(),
  );
const adjust = (
  quantityDelta: number,
  reasonCode = 'production_consume',
  key?: string,
  expected = 200,
) =>
  call(
    'POST',
    `/inventory/items/${itemId}/adjust`,
    { warehouseId, quantityDelta, reasonCode },
    tokens.warehouse_staff,
    expected,
    key,
  );

const capturedMail: Array<{ to: string; body: string }> = [];
async function tokenFromMail(email: string): Promise<string> {
  const entry = await waitFor(
    'Actual verification/invitation email delivered',
    async () => capturedMail.filter((m) => m.to === email).at(-1),
    (m) => !!m?.body.match(/[?&]token=([A-Za-z0-9_-]+)/),
  );
  return entry!.body.match(/[?&]token=([A-Za-z0-9_-]+)/)![1]!;
}
const smtp = new SMTPServer({
  secure: false,
  disabledCommands: ['STARTTLS'],
  onAuth(auth, _session, cb) {
    cb(
      auth.username === 'demo' && auth.password === 'demo'
        ? null
        : new Error('Invalid demo credentials'),
      { user: 'demo' },
    );
  },
  onData(stream, session, cb) {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      const decoded = Buffer.concat(chunks)
        .toString()
        .replace(/=\r?\n/g, '')
        .replace(/=([A-Fa-f\d]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
      for (const to of session.envelope.rcptTo)
        capturedMail.push({ to: to.address, body: decoded });
      void mkdir('.demo-data/mail', { recursive: true })
        .then(() =>
          writeFile(`.demo-data/mail/${Date.now()}-${randomUUID()}.eml`, Buffer.concat(chunks)),
        )
        .then(() => cb(), cb);
    });
  },
});
let api: ReturnType<ReturnType<typeof createApp>['listen']>;
let emailWorker: ReturnType<typeof startEmailWorker>;
let forecastWorker: ReturnType<typeof startForecastWorker> | undefined;
let scheduledWorker: ReturnType<typeof startScheduledWorker> | undefined;
let error: string | undefined;

async function main() {
  try {
    await connectDatabase();
    await connectRedis();
    await new Promise<void>((resolve, reject) => {
      smtp.once('error', reject);
      smtp.listen(env.SMTP_PORT, '127.0.0.1', resolve);
    });
    api = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => api.once('listening', resolve));
    base = `http://127.0.0.1:${(api.address() as { port: number }).port}/api/v1`;
    emailWorker = startEmailWorker();
    const registered = await call(
      'POST',
      '/auth/register',
      {
        factory: {
          name: `Low Stock QA ${suffix}`,
          businessType: 'rmg',
          country: 'BD',
          timeZone: 'Asia/Dhaka',
        },
        owner: {
          fullName: 'Low Stock QA Owner',
          email: `owner-${suffix}@low-stock.example.test`,
          password,
        },
      },
      '',
      201,
    );
    tenantId = new Types.ObjectId(registered.factory.id);
    owner = (
      await call(
        'POST',
        '/auth/login',
        { email: `owner-${suffix}@low-stock.example.test`, password },
        '',
      )
    ).accessToken;
    await call(
      'POST',
      '/auth/verify-email',
      { token: await tokenFromMail(`owner-${suffix}@low-stock.example.test`) },
      '',
      200,
    );
    // Synthetic fixture permits the four-role regression; no gateway purchase is claimed.
    await scope(() =>
      Subscription.updateOne(
        {},
        {
          $set: {
            tier: 'enterprise',
            status: 'active',
            currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
          },
        },
      ).exec(),
    );
    for (const role of ['manager', 'warehouse_staff', 'viewer']) {
      const email = `${role}-${suffix}@low-stock.example.test`;
      await call('POST', '/auth/invite', { email, fullName: `QA ${role}`, role }, owner, 201);
      const invitationToken = await tokenFromMail(email);
      const accepted = await call(
        'POST',
        '/auth/accept-invite',
        { token: invitationToken, password },
        '',
        200,
      );
      tokens[role] = accepted.accessToken;
      userIds[role] = accepted.user.id;
    }
    await call(
      'PATCH',
      '/auth/me',
      { notificationPrefs: { lowStock: { inApp: false, email: true } } },
      tokens.manager,
    );
    await call(
      'PATCH',
      '/auth/me',
      { notificationPrefs: { lowStock: { inApp: true, email: false } } },
      tokens.warehouse_staff,
    );
    const warehouse = await call(
      'POST',
      '/inventory/warehouses',
      { name: 'Gazipur QA Store', code: `QA-${suffix}` },
      owner,
      201,
    );
    warehouseId = warehouse.id;
    const item = await call(
      'POST',
      '/inventory/items',
      {
        sku: `LS-${suffix}`,
        name: 'Bangladesh cotton low-stock QA',
        unit: 'kg',
        type: 'raw_material',
        reorderLevel: 100,
        currency: 'BDT',
      },
      owner,
      201,
    );
    itemId = item.id;
    await adjust(200, 'opening');
    pass('Opening above threshold is not low stock', !(await balance())!.lowStockSince);
    await adjust(-100);
    pass('Equality (100/100) is healthy', !(await balance())!.lowStockSince);
    await adjust(-80);
    const episode = (await balance())!.lowStockEpisodeId!.toString();
    pass(
      'Consumption creates durable low-stock episode immediately',
      !!(await balance())!.lowStockSince,
    );
    const low = await call('GET', '/inventory/low-stock?limit=100');
    pass(
      'Low-stock API includes new item immediately',
      low.some((row: any) => row.itemId === itemId),
    );
    await processTenantLowStock(tenantId);
    pass(
      'Channel preferences respected: owner + warehouse in-app only',
      (await alerts()).length === 2,
    );
    pass(
      'Viewer receives no low-stock alert',
      !(await alerts()).some((row) => row.userId.toString() === userIds.viewer),
    );
    await waitFor(
      'Real SMTP delivered owner + manager alerts',
      deliveries,
      (rows) => rows.filter((row) => row.state === 'delivered').length === 2,
    );
    pass(
      'Warehouse email preference disabled',
      !(await deliveries()).some((row) => row.to.startsWith('warehouse_staff-')),
    );
    const queued = await forecastQueue.getJobs(['waiting', 'active', 'delayed']);
    pass(
      'Low stock automatically queued forecast as owner',
      queued.some(
        (job) =>
          job.data.lowStockEpisodeId === episode && job.data.requestedBy === registered.owner.id,
      ),
    );
    forecastWorker = startForecastWorker();
    const live = await waitFor(
      'Automatic forecast persisted by real worker/provider',
      () => scope(() => Forecast.findOne({ itemId }).sort({ generatedAt: -1 }).lean().exec()),
      (row) => !!row,
      180_000,
    );
    pass('Automatic AI is actual provider output, not fallback', live && !live.provenance.fallback);
    await forecastWorker.close();
    forecastWorker = undefined;
    const before = await alerts();
    const key = randomUUID();
    await adjust(-1, 'production_consume', key);
    await adjust(-1, 'production_consume', key);
    pass('Idempotent retry does not consume twice', (await balance())!.quantity === 19);
    await processTenantLowStock(tenantId);
    await processTenantLowStock(tenantId);
    pass(
      'Same low episode has no duplicate notifications',
      (await alerts()).length === before.length,
    );
    pass('Same low episode has no duplicate emails', (await deliveries()).length === 2);
    pass(
      'Same episode identity retained after further consumption',
      (await balance())!.lowStockEpisodeId!.toString() === episode,
    );
    pass(
      'Recent forecast schedules next check without new item job',
      (await balance())!.lowStockNextForecastAt!.getTime() > Date.now() + 6 * 3600_000,
    );
    // Exercise a due daily check by advancing timestamps on this QA tenant only.
    for (const job of await forecastQueue.getJobs(['completed'])) {
      if (job.data.itemId === itemId) await job.remove();
    }
    await scope(async () => {
      await Forecast.updateOne(
        { _id: live!._id },
        { $set: { generatedAt: new Date(Date.now() - 25 * 3600_000) } },
      ).exec();
      await StockBalance.updateOne(
        { itemId, warehouseId },
        { $set: { lowStockNextForecastAt: new Date(0) } },
      ).exec();
    });
    await processTenantLowStock(tenantId);
    pass(
      'Daily due low-stock check queues a fresh item job',
      (await forecastQueue.getJobs(['waiting', 'delayed'])).some(
        (job) => job.data.itemId === itemId,
      ),
    );
    await scope(() =>
      Forecast.updateOne({ _id: live!._id }, { $set: { generatedAt: live!.generatedAt } }).exec(),
    );
    await adjust(-1000, 'production_consume', undefined, 400);
    pass(
      'Rejected adjustment preserves balance and alert episode',
      (await balance())!.quantity === 19 &&
        (await balance())!.lowStockEpisodeId!.toString() === episode,
    );

    const supplier = await call(
      'POST',
      '/suppliers',
      {
        legalName: `QA Cotton Supplier ${suffix}`,
        status: 'active',
        contacts: [
          { name: 'QA Sales', email: `sales-${suffix}@low-stock.example.test`, isPrimary: true },
        ],
      },
      owner,
      201,
    );
    const po = await call(
      'POST',
      '/purchase-orders',
      {
        supplierId: supplier.id,
        warehouseId,
        currency: 'BDT',
        paymentTermsDays: 30,
        expectedDeliveryAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
        lines: [{ itemId, quantityOrdered: 100, unitPrice: 480 }],
        taxRate: 0,
      },
      tokens.manager,
      201,
    );
    await call('POST', `/purchase-orders/${po.id}/submit`, {}, tokens.manager);
    await call('POST', `/purchase-orders/${po.id}/approve`, {});
    await call(
      'POST',
      `/purchase-orders/${po.id}/send`,
      { sentTo: `sales-${suffix}@low-stock.example.test` },
      tokens.manager,
    );
    const receipt = (quantity: number) =>
      call(
        'POST',
        `/purchase-orders/${po.id}/receipts`,
        { warehouseId, lines: [{ poLineId: po.lines[0].id, itemId, quantity, unitCost: 480 }] },
        tokens.warehouse_staff,
        201,
      );
    await receipt(40);
    pass(
      'Partial GRN below threshold retains same episode',
      (await balance())!.quantity === 59 &&
        (await balance())!.lowStockEpisodeId!.toString() === episode,
    );
    await receipt(60);
    pass(
      'Final GRN restores stock and immediately clears episode',
      (await balance())!.quantity === 119 &&
        !(await balance())!.lowStockSince &&
        !(await balance())!.lowStockEpisodeId,
    );
    pass(
      'Original notifications persist with resolvedAt metadata',
      (await alerts()).every((row) => !!row.metadata.resolvedAt),
    );
    await call('POST', `/purchase-orders/${po.id}/close`, {}, tokens.manager);
    const healthy = await call('GET', '/inventory/low-stock?limit=100');
    pass('Recovered item leaves low-stock API', !healthy.some((row: any) => row.itemId === itemId));
    await adjust(-100);
    pass(
      'Falling again creates distinct episode',
      (await balance())!.lowStockEpisodeId!.toString() !== episode,
    );
    await processTenantLowStock(tenantId);
    await waitFor(
      'Second episode delivers one fresh email per subscribed recipient',
      deliveries,
      (rows) => rows.filter((r) => r.state === 'delivered').length === 4,
    );
    pass('Second episode creates fresh in-app notifications', (await alerts()).length === 4);
    await call('PATCH', `/inventory/items/${itemId}`, { reorderLevel: 10 });
    pass(
      'Lowering reorder threshold immediately resolves alert',
      !(await balance())!.lowStockSince,
    );
    await call('PATCH', `/inventory/items/${itemId}`, { reorderLevel: 50 });
    pass('Raising threshold immediately detects low stock', !!(await balance())!.lowStockSince);
    await scope(() =>
      StockBalance.updateOne(
        { itemId, warehouseId },
        { $set: { reorderLevelOverride: 10 } },
      ).exec(),
    );
    await processTenantLowStock(tenantId);
    pass(
      'Warehouse override takes precedence over item threshold',
      !(await balance())!.lowStockSince,
    );
    await scope(() =>
      StockBalance.updateOne({ itemId, warehouseId }, { $set: { reorderLevelOverride: 0 } }).exec(),
    );
    await processTenantLowStock(tenantId);
    pass('Zero warehouse threshold disables low stock', !(await balance())!.lowStockSince);
    await scope(() =>
      StockBalance.updateOne(
        { itemId, warehouseId },
        { $set: { reorderLevelOverride: null } },
      ).exec(),
    );
    await processTenantLowStock(tenantId);
    pass('Removing override restores item threshold', !!(await balance())!.lowStockSince);
    await call('PATCH', `/inventory/items/${itemId}`, { reorderLevel: 0 });
    pass('Zero item threshold disables low stock', !(await balance())!.lowStockSince);
    await call('PATCH', `/inventory/items/${itemId}`, { reorderLevel: 100 });
    await processTenantLowStock(tenantId);
    const activeEpisode = (await balance())!.lowStockEpisodeId!.toString();
    await call('DELETE', `/inventory/items/${itemId}`, undefined, owner, 204);
    pass('Archiving item immediately resolves pending episode', !(await balance())!.lowStockSince);
    pass(
      'Archive marks episode notifications resolved',
      (await alerts())
        .filter((r) => r.metadata.episodeId === activeEpisode)
        .every((r) => !!r.metadata.resolvedAt),
    );

    const atomicSku = `LS-ROLLBACK-${suffix}`;
    const failedImport = await call('POST', '/inventory/bulk-import', {
      atomic: true,
      items: [
        {
          sku: atomicSku,
          name: 'Rolled-back low item',
          unit: 'kg',
          type: 'raw_material',
          reorderLevel: 100,
          openingBalance: { warehouseCode: warehouse.code, quantity: 5 },
        },
        {
          sku: `${atomicSku}-BAD`,
          name: 'Invalid warehouse',
          unit: 'kg',
          type: 'raw_material',
          openingBalance: { warehouseCode: 'DOES-NOT-EXIST', quantity: 5 },
        },
      ],
    });
    pass('Atomic import failure returns errors', failedImport.errors.length > 0);
    pass(
      'Rolled-back item/low-stock state never persisted',
      !(await scope(() => Item.findOne({ sku: atomicSku }).lean().exec())),
    );
    const raceItem = await call(
      'POST',
      '/inventory/items',
      {
        sku: `LS-RACE-${suffix}`,
        name: 'Concurrent cotton movements',
        unit: 'kg',
        type: 'raw_material',
        reorderLevel: 100,
      },
      owner,
      201,
    );
    const raceAdjust = (quantityDelta: number) =>
      call(
        'POST',
        `/inventory/items/${raceItem.id}/adjust`,
        { warehouseId, quantityDelta, reasonCode: 'count_correction' },
        tokens.warehouse_staff,
      );
    await raceAdjust(100);
    await Promise.all([raceAdjust(-10), raceAdjust(-10)]);
    const raceBalance = await scope(() =>
      StockBalance.findOne({ itemId: raceItem.id, warehouseId }).lean().exec(),
    );
    pass(
      'Concurrent consumption commits correct balance and one active episode',
      raceBalance!.quantity === 80 && !!raceBalance!.lowStockEpisodeId,
    );
    await emailWorker.pause();
    await processTenantLowStock(tenantId);
    const raceEpisode = raceBalance!.lowStockEpisodeId!.toString();
    pass(
      'Concurrent crossing creates one notification per recipient',
      (await scope(() =>
        Notification.countDocuments({ 'metadata.episodeId': raceEpisode }).exec(),
      )) === 2,
    );
    await raceAdjust(20);
    await emailWorker.resume();
    await waitFor(
      'Resolved pending email is skipped by real worker',
      async () => {
        const jobs = await emailQueue.getJobs(['waiting', 'active', 'delayed']);
        return jobs.filter((job) => job.data.lowStockEpisodeId === raceEpisode).length;
      },
      (count) => count === 0,
    );
    pass(
      'Resolved episode sends no obsolete low-stock email',
      !(await scope(() =>
        EmailDelivery.exists({ subject: `Low stock: LS-RACE-${suffix.toUpperCase()}` }).exec(),
      )),
    );
    const secondWarehouse = await call(
      'POST',
      '/inventory/warehouses',
      { name: 'Savar QA Store', code: `QA2-${suffix}` },
      owner,
      201,
    );
    await call(
      'POST',
      `/inventory/items/${raceItem.id}/transfer`,
      { fromWarehouseId: warehouseId, toWarehouseId: secondWarehouse.id, quantity: 10 },
      tokens.warehouse_staff,
    );
    const transferBalances = await scope(() =>
      StockBalance.find({ itemId: raceItem.id }).lean().exec(),
    );
    pass(
      'Transfer reconciles both warehouses and preserves total stock',
      transferBalances.length === 2 &&
        transferBalances.every((row) => !!row.lowStockSince) &&
        transferBalances.reduce((sum, row) => sum + row.quantity, 0) === 100,
    );
    await call('DELETE', `/inventory/items/${raceItem.id}`, undefined, owner, 204);
    const other = await call(
      'POST',
      '/auth/register',
      {
        factory: { name: `Isolated Factory ${suffix}`, businessType: 'rmg' },
        owner: {
          fullName: 'Other Factory Owner',
          email: `other-${suffix}@low-stock.example.test`,
          password,
        },
      },
      '',
      201,
    );
    await call(
      'POST',
      '/auth/verify-email',
      { token: await tokenFromMail(`other-${suffix}@low-stock.example.test`) },
      '',
      200,
    );
    const otherToken = (
      await call(
        'POST',
        '/auth/login',
        { email: `other-${suffix}@low-stock.example.test`, password },
        '',
      )
    ).accessToken;
    pass(
      'Another factory cannot see this factory low-stock balances',
      !(await call('GET', '/inventory/low-stock', undefined, otherToken)).some(
        (row: any) => row.tenantId === tenantId.toString(),
      ),
    );
    pass(
      'Another factory receives no leaked low-stock notifications',
      (await call('GET', '/notifications?category=low_stock', undefined, otherToken)).length === 0,
    );
    const jobsBeforeQuota = (
      await forecastQueue.getJobs(['waiting', 'delayed', 'completed', 'failed'])
    ).length;
    await scope(() =>
      AiUsage.updateOne(
        { period: periodKey() },
        { $set: { promptTokens: 50_000_000 } },
        { upsert: true },
      ).exec(),
    );
    const quotaItem = await call(
      'POST',
      '/inventory/items',
      {
        sku: `LS-QUOTA-${suffix}`,
        name: 'Quota-limited cotton',
        unit: 'kg',
        type: 'raw_material',
        reorderLevel: 100,
      },
      owner,
      201,
    );
    await call('POST', `/inventory/items/${quotaItem.id}/adjust`, {
      warehouseId,
      quantityDelta: 5,
      reasonCode: 'opening',
    });
    await processTenantLowStock(tenantId);
    pass(
      'Exhausted quota still creates low-stock notifications',
      !!(await scope(() => Notification.exists({ 'metadata.itemId': quotaItem.id }).exec())),
    );
    pass(
      'Exhausted quota does not enqueue provider work',
      (await forecastQueue.getJobs(['waiting', 'delayed', 'completed', 'failed'])).length ===
        jobsBeforeQuota,
    );
    pass(
      'Quota failure uses six-hour retry delay',
      (await scope(() =>
        StockBalance.findOne({ itemId: quotaItem.id }).lean().exec(),
      ))!.lowStockNextForecastAt!.getTime() >
        Date.now() + 5 * 3600_000,
    );
    await scope(() =>
      AiUsage.updateOne({ period: periodKey() }, { $set: { promptTokens: 0 } }).exec(),
    );

    pass(
      'Active low-stock item remains isolated from another factory',
      !(await call('GET', '/inventory/low-stock', undefined, otherToken)).some(
        (row: any) => row.itemId === quotaItem.id,
      ),
    );
    forecastWorker = startForecastWorker();
    await waitFor(
      'Recovered/archived forecast jobs drained safely',
      async () => (await forecastQueue.getJobs(['waiting', 'active', 'delayed'])).length,
      (count) => count === 0,
    );
    await forecastWorker.close();
    forecastWorker = undefined;
    pass(
      'Stale automatic jobs produced no extra forecast/provider result',
      (await scope(() => Forecast.countDocuments().exec())) === 1,
    );

    const rateItem = await call(
      'POST',
      '/inventory/items',
      {
        sku: `LS-RATE-${suffix}`,
        name: 'Rate-limited cotton',
        unit: 'kg',
        type: 'raw_material',
        reorderLevel: 100,
      },
      owner,
      201,
    );
    await call('POST', `/inventory/items/${rateItem.id}/adjust`, {
      warehouseId,
      quantityDelta: 5,
      reasonCode: 'opening',
    });
    await scope(() =>
      User.updateOne({ _id: userIds.manager }, { $set: { status: 'disabled' } }).exec(),
    );
    const minute = Math.floor(Date.now() / 60_000);
    for (const window of [minute, minute + 1])
      await redisCache.set(
        `${env.QUEUE_PREFIX}:low-stock-ai:${tenantId}:${window}`,
        '10',
        'EX',
        120,
      );
    const jobsBeforeRate = (
      await forecastQueue.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed'])
    ).length;
    await processTenantLowStock(tenantId);
    pass(
      'Automatic AI minute cap prevents queue flooding',
      (await forecastQueue.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed']))
        .length === jobsBeforeRate,
    );
    const rateBalance = await scope(() =>
      StockBalance.findOne({ itemId: rateItem.id }).lean().exec(),
    );
    pass(
      'Minute limit retries after one minute, not a full day',
      rateBalance!.lowStockNextForecastAt!.getTime() > Date.now() &&
        rateBalance!.lowStockNextForecastAt!.getTime() < Date.now() + 65_000,
    );
    await waitFor(
      'Disabled manager receives no email; active owner still receives alert',
      () =>
        scope(() =>
          EmailDelivery.find({ subject: `Low stock: LS-RATE-${suffix.toUpperCase()}` })
            .lean()
            .exec(),
        ),
      (rows) =>
        rows.length === 1 && rows[0]!.state === 'delivered' && rows[0]!.to.startsWith('owner-'),
    );
    await scope(() =>
      User.updateOne({ _id: userIds.manager }, { $set: { status: 'active' } }).exec(),
    );
    await call('DELETE', `/inventory/items/${rateItem.id}`, undefined, owner, 204);
    // Exercise real scheduler registration without scanning other tenants.
    env.LOW_STOCK_MONITOR_TENANT_IDS = tenantId.toString();
    scheduledWorker = startScheduledWorker();
    const schedule = await scheduledQueue.upsertJobScheduler(
      `low-stock-test-${suffix}`,
      { every: 10_000 },
      { name: 'scheduled.inventory.low_stock_monitor', data: {} },
    );
    await waitFor(
      'BullMQ periodic monitor ran successfully',
      () => scheduledQueue.getJob(schedule.id!),
      (job) => !!job && job.finishedOn !== undefined,
    );
    await scheduledQueue.removeJobScheduler(`low-stock-test-${suffix}`);
    pass(
      'Movement ledger matches recovered-then-consumed stock',
      (await scope(() => StockMovement.find({ itemId }).lean().exec())).reduce(
        (sum, row) => sum + row.quantity,
        0,
      ) === 19,
    );
    console.log(`REAL LOW-STOCK TEST COMPLETE: ${checks.length} checks`);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await mkdir('artifacts', { recursive: true });
    await writeFile(
      'artifacts/low-stock-test-results.json',
      JSON.stringify(
        {
          at: new Date().toISOString(),
          tenantId: tenantId!?.toString(),
          queuePrefix: env.QUEUE_PREFIX,
          checks,
          error,
          passed: !error,
        },
        null,
        2,
      ),
    );
    await scheduledWorker!?.close();
    await forecastWorker?.close();
    await emailWorker!?.close();
    await new Promise<void>((resolve) => api!?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => smtp.close(resolve));
    await closeQueues();
    await disconnectRedis();
    await disconnectDatabase();
  }
}
void main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
