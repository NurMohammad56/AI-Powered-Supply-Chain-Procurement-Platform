/** Real HTTP + MongoDB presentation seed and regression runner. No API/AI mocks. */
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { env } from '../src/config/env.js';
import { tenantStorage } from '../src/shared/db/tenancyPlugin.js';
import { Factory } from '../src/modules/auth/models/factory.model.js';
import { User } from '../src/modules/auth/models/user.model.js';
import { hashPassword } from '../src/shared/auth/password.js';
import { Subscription } from '../src/modules/billing/models/subscription.model.js';
import { Invoice } from '../src/modules/billing/models/invoice.model.js';
import { StockMovement } from '../src/modules/inventory/models/stockMovement.model.js';
import { StockBalance } from '../src/modules/inventory/models/stockBalance.model.js';
import { QuotationRequest } from '../src/modules/supplier/models/quotationRequest.model.js';
import { Notification } from '../src/modules/notification/models/notification.model.js';
import { Forecast } from '../src/modules/ai/models/forecast.model.js';
import { AiInsight } from '../src/modules/ai/models/aiInsight.model.js';
import { runTextPipeline } from '../src/modules/ai/forecastPipeline.js';
import { aiUsageRepository, estimateCostMicroUsd } from '../src/modules/ai/aiUsage.repository.js';
import { closeQueues } from '../src/shared/queue/queues.js';
import { disconnectRedis } from '../src/config/redis.js';

const base = process.env.DEMO_BASE_URL || 'http://localhost:4001/api/v1';
const password = 'GarmentsDemo!2026';
const runId = randomUUID().slice(0, 8);
let token = '';
const results: any[] = [];
const manifest: any = {
  baseUrl: base,
  generatedAt: new Date().toISOString(),
  runId,
  password,
  users: {},
  warehouses: [],
  categories: [],
  suppliers: [],
  items: [],
  quotations: [],
  purchaseOrders: [],
  forecasts: [],
};
let tenantId: Types.ObjectId;
let ownerId: Types.ObjectId;
const scope = <T>(fn: () => Promise<T>) => tenantStorage.run({ tenantId }, fn);
const future = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
function check(name: string, pass: boolean, detail?: any) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : ' ' + JSON.stringify(detail)}`);
}
async function api(
  method: string,
  path: string,
  body?: any,
  expected: number[] = [200, 201, 204],
  auth = token,
  extra: Record<string, string> = {},
) {
  const start = Date.now();
  const response = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      'Idempotency-Key': randomUUID(),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  if (response.status === 429 && !expected.includes(429)) {
    console.log(`THROTTLED ${path}; waiting for the real rate-limit window`);
    await new Promise((resolve) => setTimeout(resolve, 61000));
    return api(method, path, body, expected, auth, extra);
  }
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { text };
  }
  const pass = expected.includes(response.status);
  results.push({
    name: `${method} ${path}`,
    status: response.status,
    expected,
    pass,
    durationMs: Date.now() - start,
    ...(pass ? {} : { error: payload }),
  });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${method} ${path} ${response.status}`);
  if (!pass && expected.every((s) => s < 400)) throw new Error(JSON.stringify(payload));
  return payload.data ?? payload;
}
async function main() {
  if (
    !env.MONGO_URI.includes('127.0.0.1:27018/garments_demo') &&
    process.env.DEMO_ALLOW_REMOTE !== '1'
  )
    throw new Error(
      'Remote demo seeding requires DEMO_ALLOW_REMOTE=1. This creates a new isolated demo tenant and preserves existing records.',
    );
  await mkdir('artifacts', { recursive: true });
  await mongoose.connect(env.MONGO_URI);
  check(
    'Readiness: real Mongo + Redis',
    ((await (await fetch(base.replace('/api/v1', '/readyz'))).json()) as any).ok === true,
  );
  await api('GET', '/inventory/items', undefined, [401], '');
  await api('POST', '/auth/login', { email: 'nobody@example.test', password: 'wrong' }, [401], '');
  await api(
    'POST',
    '/auth/register',
    {
      factory: { name: `Sonar Bangla Apparel Demo ${runId}`, businessType: 'rmg' },
      owner: { fullName: 'Nusrat Jahan', email: `owner.${runId}@garments.example.test`, password },
    },
    [201],
    '',
  );
  const login = await api(
    'POST',
    '/auth/login',
    { email: `owner.${runId}@garments.example.test`, password },
    [200],
    '',
  );
  token = login.accessToken;
  tenantId = new Types.ObjectId(login.user.tenantId);
  ownerId = new Types.ObjectId(login.user.id);
  manifest.tenantId = tenantId.toString();
  manifest.users.owner = login.user.email;
  await scope(async () => {
    const sub = await Subscription.findOneAndUpdate(
      { tenantId },
      {
        $set: {
          tier: 'growth',
          status: 'active',
          gateway: 'stripe',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(future(30)),
          seats: 20,
        },
      },
      { new: true, upsert: true },
    );
    if (!sub) throw new Error('Demo subscription fixture failed');
    await User.updateOne({ _id: ownerId }, { $set: { emailVerifiedAt: new Date() } });
    await Factory.updateOne({ _id: tenantId }, { $set: { status: 'active' } });
    const hash = await hashPassword(password);
    for (const role of ['manager', 'warehouse_staff', 'viewer'] as const) {
      const email = `${role}.${runId}@garments.example.test`;
      await User.create({
        email,
        passwordHash: hash,
        fullName: {
          manager: 'Farhan Ahmed',
          warehouse_staff: 'Abdul Karim',
          viewer: 'Rumana Akter',
        }[role],
        role,
        status: 'active',
        emailVerifiedAt: new Date(),
      });
      manifest.users[role] = email;
    }
    for (let i = 0; i < 6; i++) {
      const status = ['paid', 'paid', 'paid', 'open', 'failed', 'refunded'][i];
      await Invoice.create({
        subscriptionId: sub._id,
        number: `DEMO-${runId}-${i}`,
        amountSubtotal: 2500000,
        amountTax: 0,
        amountTotal: 2500000,
        currency: 'BDT',
        status,
        gateway: 'stripe',
        issuedAt: new Date(Date.now() - i * 30 * 86400000),
        paidAt: status === 'paid' ? new Date() : null,
        dueAt: new Date(future(7)),
        failureReason:
          status === 'failed' ? 'Synthetic demo: insufficient funds; no gateway charge' : null,
      });
    }
  });
  token = (await api('POST', '/auth/login', { email: manifest.users.owner, password }, [200], ''))
    .accessToken;
  const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
  check('Paid subscription tier carried by real login JWT', claims.tier === 'growth', claims.tier);
  for (const [code, name, city] of [
    ['GAZ', 'Gazipur Fabric Store', 'Gazipur'],
    ['SAV', 'Savar Trims Store', 'Savar'],
    ['CTG', 'Chattogram Export Packing', 'Chattogram'],
  ]) {
    manifest.warehouses.push(
      await api('POST', '/inventory/warehouses', {
        name,
        code,
        address: { street: 'Demo Industrial Area', city, country: 'BD', postalCode: '1700' },
      }),
    );
  }
  for (const name of [
    'Knit Fabrics',
    'Woven and Denim',
    'Sewing Trims',
    'Packaging',
    'Dyes and Chemicals',
    'Finished Garments',
  ])
    manifest.categories.push(await api('POST', '/inventory/categories', { name }));
  const supplierNames = [
    'Meghna Knit Fabrics Demo Ltd',
    'Padma Denim Demo Ltd',
    'Gazipur Accessories Demo Ltd',
    'Narayanganj Thread Demo Ltd',
    'Chattogram Packaging Demo Ltd',
    'Savar Dye Chemicals Demo Ltd',
    'Bengal Export Trims Demo Ltd',
    'Dhaka Backup Textiles Demo Ltd',
  ];
  for (let i = 0; i < supplierNames.length; i++)
    manifest.suppliers.push(
      await api('POST', '/suppliers', {
        legalName: supplierNames[i],
        tradingName: supplierNames[i],
        leadTimeDays: 5 + i * 3,
        paymentTermsDays: [30, 45, 60][i % 3],
        tier: ['strategic', 'preferred', 'backup'][i % 3],
        contacts: [
          {
            name: `Demo Sales ${i + 1}`,
            email: `sales${i}@garments.example.test`,
            phone: `+880170000000${i}`,
            isPrimary: true,
          },
        ],
        address: {
          street: 'Demo BSCIC Industrial Estate',
          city: ['Gazipur', 'Narayanganj', 'Dhaka', 'Chattogram'][i % 4],
          country: 'BD',
        },
        categoryIds: [manifest.categories[i % 6].id],
      }),
    );
  const catalogue = [
    ['Single Jersey Cotton 160 GSM', 'kg', 0, 480, 80],
    ['Pique Cotton 220 GSM', 'kg', 0, 560, 55],
    ['Rib Fabric 1x1', 'kg', 0, 520, 24],
    ['Fleece Brushed 280 GSM', 'kg', 0, 650, 40],
    ['Stretch Denim 10 oz', 'm', 1, 330, 110],
    ['Cotton Twill 180 GSM', 'm', 1, 240, 85],
    ['Poplin White 120 GSM', 'm', 1, 190, 70],
    ['Dead Stock Printed Voile', 'm', 1, 160, 0],
    ['Polyester Sewing Thread', 'pcs', 2, 65, 160],
    ['Metal Zipper 7 Inch', 'pcs', 2, 18, 220],
    ['Plastic Button 18L', 'pcs', 2, 2, 600],
    ['Woven Size Label', 'pcs', 2, 3, 400],
    ['Export Carton 5 Ply', 'pcs', 3, 95, 45],
    ['Recycled Polybag', 'pcs', 3, 5, 450],
    ['Barcode Hangtag', 'pcs', 3, 4, 350],
    ['Carton Sealing Tape', 'roll', 3, 60, 15],
    ['Reactive Blue Dye', 'kg', 4, 820, 12],
    ['Softener Textile Grade', 'litre', 4, 180, 18],
    ['Hydrogen Peroxide Demo', 'litre', 4, 95, 14],
    ['Enzyme Wash Agent', 'kg', 4, 360, 9],
    ['Basic Crew Neck Tee', 'pcs', 5, 280, 90],
    ['Ladies Denim Jeans', 'pcs', 5, 780, 60],
    ['Polo Shirt Navy', 'pcs', 5, 430, 75],
    ['Kids Cotton Hoodie', 'pcs', 5, 580, 45],
  ];
  for (let i = 0; i < catalogue.length; i++) {
    const [name, unit, cat, cost, daily] = catalogue[i] as [string, string, number, number, number];
    const item = await api('POST', '/inventory/items', {
      sku: `BD-RMG-${String(i + 1).padStart(3, '0')}`,
      name,
      unit,
      type:
        cat === 5
          ? 'finished_good'
          : cat === 3
            ? 'packaging'
            : cat === 4
              ? 'consumable'
              : 'raw_material',
      categoryId: manifest.categories[cat].id,
      preferredSupplierId: manifest.suppliers[i % 8].id,
      reorderLevel: daily * 12 || 50,
      movingAverageCost: cost,
      currency: 'BDT',
    });
    item.demoDaily = daily;
    manifest.items.push(item);
    const wh = manifest.warehouses[i % 3];
    await scope(async () => {
      const movements: any[] = [];
      let total = 0;
      for (let day = 180; day >= 1; day--) {
        const date = new Date(Date.now() - day * 86400000);
        date.setUTCHours(4, 0, 0, 0);
        // Friday shutdown, upward export production trend, recurring replenishments.
        const qty =
          day > 150 && daily === 0
            ? 2
            : daily === 0
              ? 0
              : date.getUTCDay() === 5
                ? 0
                : Math.round(daily * (0.75 + (180 - day) / 360) * (1 + ((day % 7) - 3) * 0.035));
        if (!qty) continue;
        total += qty;
        movements.push({
          itemId: item.id,
          warehouseId: wh.id,
          type: 'out',
          quantity: -qty,
          unitCost: cost,
          reasonCode: 'production_consume',
          reference: { kind: 'manual', id: null },
          performedBy: ownerId,
          performedAt: date,
        });
      }
      const closing = i % 5 === 0 ? Math.max(0, daily * 2) : daily * 25 || 420;
      movements.unshift({
        itemId: item.id,
        warehouseId: wh.id,
        type: 'adjustment',
        quantity: total + closing,
        unitCost: cost,
        reasonCode: 'opening',
        reference: { kind: 'opening', id: null },
        performedBy: ownerId,
        performedAt: new Date(Date.now() - 181 * 86400000),
      });
      await StockMovement.insertMany(movements);
      await StockBalance.create({
        itemId: item.id,
        warehouseId: wh.id,
        quantity: closing,
        lastMovementAt: movements.at(-1).performedAt,
        lowStockSince: closing < daily * 12 ? new Date() : null,
      });
    });
  }
  const item = manifest.items[0],
    wh = manifest.warehouses[0];
  await api('GET', '/auth/me');
  await api('GET', '/auth/users');
  await api('PATCH', '/auth/me', { fullName: 'Nusrat Jahan - Procurement Owner' });
  const viewer = (
    await api('POST', '/auth/login', { email: manifest.users.viewer, password }, [200], '')
  ).accessToken;
  await api(
    'POST',
    '/inventory/items',
    { sku: 'FORBIDDEN', name: 'Forbidden', unit: 'kg', type: 'raw_material' },
    [403],
    viewer,
  );
  await api('GET', '/inventory/items/not-an-id', undefined, [400]);
  await api(
    'POST',
    '/inventory/items',
    { sku: item.sku, name: 'Duplicate', unit: 'kg', type: 'raw_material' },
    [409],
  );
  await api(
    'POST',
    `/inventory/items/${item.id}/adjust`,
    { warehouseId: wh.id, quantityDelta: 0, reasonCode: 'opening' },
    [400],
  );
  await api(
    'POST',
    `/inventory/items/${item.id}/adjust`,
    { warehouseId: wh.id, quantityDelta: -9999999, reasonCode: 'production_consume' },
    [400, 409],
  );
  await api('POST', `/inventory/items/${item.id}/adjust`, {
    warehouseId: wh.id,
    quantityDelta: 100,
    reasonCode: 'count_correction',
  });
  await api('POST', `/inventory/items/${item.id}/transfer`, {
    fromWarehouseId: wh.id,
    toWarehouseId: manifest.warehouses[1].id,
    quantity: 20,
  });
  const idem = randomUUID();
  const p1 = await api(
    'POST',
    `/inventory/items/${item.id}/adjust`,
    { warehouseId: wh.id, quantityDelta: 10, reasonCode: 'recount' },
    [200, 201],
    token,
    { 'Idempotency-Key': idem },
  );
  const p2 = await api(
    'POST',
    `/inventory/items/${item.id}/adjust`,
    { warehouseId: wh.id, quantityDelta: 10, reasonCode: 'recount' },
    [200, 201],
    token,
    { 'Idempotency-Key': idem },
  );
  check('Idempotency replay returns same movement', JSON.stringify(p1) === JSON.stringify(p2));
  // Two real tenants: owner B must not access owner A stock.
  await api(
    'POST',
    '/auth/register',
    {
      factory: { name: `Isolation Audit ${runId}`, businessType: 'rmg' },
      owner: {
        fullName: 'Isolation Test',
        email: `isolation.${runId}@garments.example.test`,
        password,
      },
    },
    [201],
    '',
  );
  const other = (
    await api(
      'POST',
      '/auth/login',
      { email: `isolation.${runId}@garments.example.test`, password },
      [200],
      '',
    )
  ).accessToken;
  await api('GET', `/inventory/items/${item.id}`, undefined, [404], other);
  for (let q = 0; q < 6; q++) {
    const it = manifest.items[q];
    const rfq = await api('POST', '/quotations', {
      validUntil: future(10),
      lines: [{ itemId: it.id, quantity: 1000, targetUnitPrice: it.movingAverageCost }],
      invitedSuppliers: manifest.suppliers.slice(0, 3).map((s: any, i: number) => ({
        supplierId: s.id,
        contactEmail: `sales${i}@garments.example.test`,
      })),
    });
    manifest.quotations.push(rfq);
    const raw = await scope(() => QuotationRequest.findById(rfq.id).lean().exec());
    for (let i = 0; i < 3; i++) {
      const inv = raw!.supplierInvitations[i]!;
      await api(
        'POST',
        `/public/quotations/responses/${inv.responseToken}`,
        {
          lines: [
            {
              itemId: it.id,
              unitPrice: Math.round(it.movingAverageCost * (0.92 + i * 0.04)),
              currency: 'BDT',
              moq: 100,
              leadTimeDays: 7 + i * 5,
              validityDays: 15,
            },
          ],
          comments:
            'Synthetic supplier commercial offer for presentation; no real purchase commitment.',
        },
        [200],
        '',
      );
    }
    const cmp = await api('GET', `/quotations/${rfq.id}/compare`);
    check(
      `RFQ ${q + 1}: live AI comparison`,
      typeof cmp.aiSummary === 'string' && cmp.aiSummary.length > 50,
    );
    if (q < 4) {
      const accepted = await api('POST', `/quotations/${rfq.id}/accept`, {
        supplierId: manifest.suppliers[0].id,
        warehouseId: wh.id,
      });
      const po = accepted.po ?? accepted.purchaseOrder;
      if (po) manifest.purchaseOrders.push(po);
    }
  }
  // Each PO state is reached through real public API transitions.
  for (const target of [
    'draft',
    'pending_approval',
    'approved',
    'sent',
    'partially_received',
    'fully_received',
    'closed',
    'cancelled',
    'rejected',
  ]) {
    let po = await api('POST', '/purchase-orders', {
      supplierId: manifest.suppliers[0].id,
      warehouseId: wh.id,
      expectedDeliveryAt: future(14),
      paymentTermsDays: 30,
      currency: 'BDT',
      lines: [{ itemId: item.id, quantityOrdered: 100, unitPrice: 480 }],
      taxRate: 0,
    });
    await api(
      'POST',
      `/purchase-orders/${po.id}/receipts`,
      { warehouseId: wh.id, lines: [{ poLineId: po.lines[0].id, itemId: item.id, quantity: 1 }] },
      [409],
    );
    if (target === 'cancelled')
      po = await api('POST', `/purchase-orders/${po.id}/cancel`, {
        reason: 'Demo buyer style cancelled',
      });
    else if (target !== 'draft') {
      po = await api('POST', `/purchase-orders/${po.id}/submit`, {});
      if (target === 'rejected')
        po = await api('POST', `/purchase-orders/${po.id}/reject`, {
          reason: 'Demo budget review required',
        });
      else if (target !== 'pending_approval') {
        po = await api('POST', `/purchase-orders/${po.id}/approve`, {});
        if (target !== 'approved') {
          po = await api('POST', `/purchase-orders/${po.id}/dispatch`, {
            sentTo: 'sales0@garments.example.test',
          });
          if (target !== 'sent') {
            await api(
              'POST',
              `/purchase-orders/${po.id}/receipts`,
              {
                warehouseId: wh.id,
                lines: [{ poLineId: po.lines[0].id, itemId: item.id, quantity: 101 }],
              },
              [400],
            );
            const receipt = await api('POST', `/purchase-orders/${po.id}/receipts`, {
              warehouseId: wh.id,
              lines: [
                {
                  poLineId: po.lines[0].id,
                  itemId: item.id,
                  quantity: 40,
                  unitCost: 480,
                  qualityNotes: 'Demo fabric inspection passed',
                },
              ],
            });
            po = receipt.po;
            if (target !== 'partially_received') {
              po = (
                await api('POST', `/purchase-orders/${po.id}/receipts`, {
                  warehouseId: wh.id,
                  lines: [
                    { poLineId: po.lines[0].id, itemId: item.id, quantity: 60, unitCost: 480 },
                  ],
                })
              ).po;
              if (target === 'closed')
                po = await api('POST', `/purchase-orders/${po.id}/close`, {});
            }
          }
        }
      }
    }
    check(`PO state ${target}`, po.state === target, po.state);
    manifest.purchaseOrders.push(po);
  }
  for (const it of manifest.items.slice(0, 12)) {
    for (const horizonDays of [30, 60, 90]) {
      let forecast = await api('POST', '/ai/forecasts', { itemId: it.id, horizonDays });
      for (let retry = 0; forecast.provenance?.fallback && retry < 3; retry++) {
        console.log(`Retrying provider outage for ${it.sku}/${horizonDays}`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        forecast = await api('POST', '/ai/forecasts', { itemId: it.id, horizonDays });
      }
      manifest.forecasts.push(forecast);
      const raw = await scope(() => Forecast.findById(forecast.id).lean().exec());
      check(
        `Live AI forecast ${it.sku}/${horizonDays}`,
        !!raw?.rawResponse && raw.provenance.fallback !== true,
        raw?.provenance,
      );
      await writeFile('artifacts/garments-demo-manifest.json', JSON.stringify(manifest, null, 2));
    }
  }
  for (const scenario of [
    'production planning and stockout risk',
    'supplier diversification and lead times',
    'inventory carrying cost and dead stock',
    'export packaging readiness',
    'budget and cash flow',
    'management presentation executive summary',
  ]) {
    await scope(async () => {
      const prompt = `You are advising a Bangladesh RMG procurement presentation. All data below is SYNTHETIC demo data. Produce a concise actionable brief on ${scenario}. Use only supplied figures. Do not claim real buyer orders or compliance certificates. Prices are illustrative BDT. DATA: ${JSON.stringify({ items: manifest.items.map((x: any) => ({ name: x.name, unit: x.unit, cost: x.movingAverageCost, dailyConsumption: x.demoDaily, reorderLevel: x.reorderLevel })), forecasts: manifest.forecasts.slice(0, 6), warehouses: manifest.warehouses.map((x: any) => x.name) })}`;
      const result = await runTextPipeline(prompt);
      await AiInsight.create({
        kind: 'procurement_brief',
        prompt,
        response: result.text,
        provenance: {
          provider: result.provider,
          model: result.model,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          latencyMs: result.latencyMs,
          failoverInvoked: result.failoverInvoked,
        },
      });
      await aiUsageRepository.increment({
        tenantId,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        callKind: 'report',
        estimatedCostMicroUsd: estimateCostMicroUsd(result),
      });
      check(`Live AI brief: ${scenario}`, result.text.length > 100);
    });
  }
  await api('POST', '/reports/budget', {
    monthlyLimit: 5000000,
    currency: 'BDT',
    warningThresholdPct: 80,
    notes: 'Synthetic garments procurement demo budget',
  });
  const range = `from=${encodeURIComponent(new Date(Date.now() - 180 * 86400000).toISOString())}&to=${encodeURIComponent(future(1))}`;
  for (const report of [
    'inventory-turnover',
    'spend-by-supplier',
    'supplier-cost-comparison',
    'dead-stock',
    'abc-analysis',
  ])
    await api('GET', `/reports/${report}?${range}`);
  for (const path of [
    '/reports/cash-flow-projection',
    '/reports/budget',
    `/reports/eoq?itemId=${item.id}&orderingCost=1500&holdingCostRate=0.2`,
    '/billing/plans',
    '/billing/subscription',
    '/billing/invoices',
    '/ai/usage',
    '/ai/insights',
    '/ai/forecasts?limit=100',
    '/suppliers',
    '/quotations',
    '/purchase-orders',
    '/inventory/low-stock',
    `/inventory/items/${item.id}/history`,
    `/inventory/items/${item.id}/balances`,
  ])
    await api('GET', path);
  const f = manifest.forecasts[0];
  for (const suffix of ['', '/evaluation', '/visualization'])
    await api('GET', `/ai/forecasts/${f.id}${suffix}`);
  await api('POST', `/ai/forecasts/${f.id}/override`, {
    quantity: f.predictedQuantity + 100,
    justification: 'Demo confirmed production increase of 100 units',
  });
  await api('POST', '/ai/forecasts', { itemId: item.id, horizonDays: 30 });
  await scope(async () => {
    for (const category of [
      'low_stock',
      'po_status',
      'delivery_reminder',
      'weekly_digest',
      'system',
    ] as const)
      await Notification.create({
        userId: ownerId,
        category,
        title: `Garments demo: ${category}`,
        body: 'Synthetic presentation notification linked to the procurement demo.',
        metadata: { demo: true },
        readAt: category === 'system' ? new Date() : null,
      });
    const sums = await StockMovement.aggregate([
      {
        $group: {
          _id: { itemId: '$itemId', warehouseId: '$warehouseId' },
          quantity: { $sum: '$quantity' },
        },
      },
    ]);
    const balances = await StockBalance.find().lean().exec();
    check(
      'Every stock balance reconciles with append-only movement ledger',
      balances.every(
        (b) =>
          Math.abs(
            b.quantity -
              (sums.find(
                (s) =>
                  String(s._id.itemId) === String(b.itemId) &&
                  String(s._id.warehouseId) === String(b.warehouseId),
              )?.quantity ?? 0),
          ) < 0.0001,
      ),
    );
  });
  await api('GET', '/notifications');
  await api('GET', '/notifications/unread-count');
  await api('POST', '/notifications/mark-read', { all: true });
  const latencies: number[] = [];
  await Promise.all(
    Array.from({ length: 20 }, async () => {
      const t = Date.now();
      const r = await fetch(base + '/inventory/items?limit=25', {
        headers: { Authorization: `Bearer ${token}` },
      });
      latencies.push(Date.now() - t);
      check('Concurrent real inventory GET', r.status === 200);
    }),
  );
  latencies.sort((a, b) => a - b);
  manifest.loadProbe = { requests: 20, p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1] };
  await api('POST', '/auth/refresh', {}, [403], '');
}
main()
  .catch((err) => {
    check('Runner completed', false, err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    const summary = {
      generatedAt: new Date().toISOString(),
      baseUrl: base,
      tenantId: tenantId?.toString(),
      passed: results.filter((x) => x.pass).length,
      failed: results.filter((x) => !x.pass).length,
      results,
    };
    await mkdir('artifacts', { recursive: true });
    await writeFile('artifacts/garments-demo-manifest.json', JSON.stringify(manifest, null, 2));
    await writeFile('artifacts/real-test-results.json', JSON.stringify(summary, null, 2));
    await closeQueues();
    await disconnectRedis();
    await mongoose.disconnect();
    console.log(`RESULT: ${summary.passed} passed, ${summary.failed} failed`);
  });
