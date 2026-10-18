import { readFile, writeFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { QueueEvents } from 'bullmq';
import { env } from '../src/config/env.js';
import { tenantStorage } from '../src/shared/db/tenancyPlugin.js';
import { User } from '../src/modules/auth/models/user.model.js';
import { Item } from '../src/modules/inventory/models/item.model.js';
import { StockBalance } from '../src/modules/inventory/models/stockBalance.model.js';
import { StockMovement } from '../src/modules/inventory/models/stockMovement.model.js';
import { PurchaseOrder } from '../src/modules/po/models/purchaseOrder.model.js';
import { QuotationRequest } from '../src/modules/supplier/models/quotationRequest.model.js';
import { Forecast } from '../src/modules/ai/models/forecast.model.js';
import { AiInsight } from '../src/modules/ai/models/aiInsight.model.js';
import { EmailDelivery } from '../src/modules/notification/models/emailDelivery.model.js';
import { AiUsage } from '../src/modules/ai/models/aiUsage.model.js';
import { Subscription } from '../src/modules/billing/models/subscription.model.js';
import { StockSnapshot } from '../src/modules/rpt/models/stockSnapshot.model.js';
import { KpiSnapshot } from '../src/modules/rpt/models/kpiSnapshot.model.js';
import { Invoice } from '../src/modules/billing/models/invoice.model.js';
import { PaymentAttempt } from '../src/modules/billing/models/paymentAttempt.model.js';
import { aiService } from '../src/modules/ai/ai.service.js';
import { redisCache, redisQueue, disconnectRedis } from '../src/config/redis.js';
import {
  closeQueues,
  reportQueue,
  scheduledQueue,
  forecastQueue,
} from '../src/shared/queue/queues.js';

const results: any[] = [];
let m: any, base: string, token: string, tenantId: Types.ObjectId;
const scope = <T>(fn: () => Promise<T>) => tenantStorage.run({ tenantId }, fn);
function check(name: string, pass: boolean, detail?: any) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : ' ' + JSON.stringify(detail)}`);
}
async function call(
  method: string,
  path: string,
  body?: any,
  expected = [200, 201, 204],
  auth = token,
  headers: Record<string, string> = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      'Idempotency-Key': randomUUID(),
      ...headers,
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { text };
  }
  check(`${method} ${path}`, expected.includes(response.status), {
    status: response.status,
    expected,
    ...(!expected.includes(response.status) ? { error: payload } : {}),
  });
  return {
    data: payload.data ?? payload,
    status: response.status,
    cookies: response.headers
      .getSetCookie()
      .map((x) => x.split(';')[0])
      .join('; '),
  };
}
async function main() {
  m = JSON.parse(await readFile('artifacts/garments-demo-manifest.json', 'utf8'));
  base = process.env.REGRESSION_BASE_URL || m.baseUrl;
  tenantId = new Types.ObjectId(m.tenantId);
  await mongoose.connect(env.MONGO_URI);
  // Each run resets only the rate buckets of this dedicated synthetic demo tenant.
  // Production quotas and the actual limiter implementation remain unchanged.
  const factory = await mongoose.connection.db!.collection('factories').findOne({ _id: tenantId });
  if (!factory?.name?.includes('Apparel Demo') || !m.users.owner.endsWith('@garments.example.test'))
    throw new Error('Regression requires the isolated synthetic demo tenant');
  await redisCache.del(`rl:upload:tenant:${m.tenantId}`, `rl:ai:tenant:${m.tenantId}`);
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const ready = await fetch(base.replace('/api/v1', '/readyz'), {
        signal: AbortSignal.timeout(2000),
      });
      if (ready.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const login = await call(
    'POST',
    '/auth/login',
    { email: m.users.owner, password: m.password },
    [200],
    '',
  );
  token = login.data.accessToken;
  const item = m.items[0],
    wh = m.warehouses[0],
    sid = m.suppliers[0].id;
  const firstPage = await call('GET', '/inventory/items?limit=1');
  if (firstPage.data.nextCursor)
    await call('GET', `/inventory/items?limit=1&cursor=${firstPage.data.nextCursor}`);
  for (const path of [
    '/inventory/warehouses?isActive=true&q=Gazipur&limit=1',
    '/inventory/warehouses?isActive=false&q=Missing',
    `/inventory/categories?q=Knit&parentId=${m.categories[0].id}`,
    `/inventory/items?q=Cotton&type=raw_material&categoryId=${m.categories[0].id}&supplierId=${sid}&archived=false&limit=1`,
    '/inventory/items?archived=true',
    `/inventory/low-stock?warehouseId=${wh.id}&limit=1`,
    `/inventory/items/${item.id}/history?warehouseId=${wh.id}&type=out&from=${encodeURIComponent(new Date(Date.now() - 180 * 86400000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}&limit=1`,
    `/suppliers?q=Meghna&status=active&tier=strategic&categoryId=${m.categories[0].id}&limit=1`,
    '/suppliers?status=inactive&tier=backup',
    '/quotations?status=open&limit=1',
    '/quotations?status=closed',
    '/quotations?status=cancelled',
    `/purchase-orders?state=sent&supplierId=${sid}&q=PO&from=${encodeURIComponent(new Date(Date.now() - 180 * 86400000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}&limit=1`,
    `/ai/forecasts?itemId=${item.id}&horizonDays=60&limit=1`,
    '/notifications?unreadOnly=true&category=system&limit=1',
    '/notifications?unreadOnly=false&category=po_status',
    '/billing/invoices?status=paid&limit=1',
    '/auth/users?role=manager&status=active&limit=1',
  ])
    await call('GET', path);
  for (const path of [
    '/inventory/items',
    '/inventory/warehouses',
    '/inventory/categories',
    '/suppliers',
    '/quotations',
    '/purchase-orders',
    '/ai/forecasts',
    '/billing/invoices',
  ])
    await call(
      'GET',
      `${path}/000000000000000000000001`,
      undefined,
      path === '/billing/invoices' ? [404] : [404],
    );
  const range = `from=${encodeURIComponent(new Date(Date.now() - 180 * 86400000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`;
  for (const endpoint of [
    '/auth/me',
    '/auth/users',
    '/inventory/warehouses',
    '/inventory/categories',
    '/inventory/items?limit=100',
    '/inventory/low-stock',
    `/inventory/items/${item.id}/history`,
    `/inventory/items/${item.id}/balances`,
    '/suppliers',
    '/quotations',
    '/purchase-orders',
    '/ai/usage',
    '/ai/forecasts',
    '/ai/insights',
    '/billing/plans',
    '/billing/subscription',
    '/billing/invoices',
    '/notifications',
    '/notifications/unread-count',
    '/reports/cash-flow-projection',
    '/reports/budget',
    `/reports/eoq?itemId=${item.id}`,
    ...[
      'inventory-turnover',
      'spend-by-supplier',
      'supplier-cost-comparison',
      'dead-stock',
      'abc-analysis',
    ].map((x) => `/reports/${x}?${range}`),
  ])
    await call('GET', endpoint);
  if (m.forecasts.length) {
    const id = m.forecasts.find((f: any) => !f.provenance?.fallback).id;
    for (const suffix of ['', '/evaluation', '/visualization'])
      await call('GET', `/ai/forecasts/${id}${suffix}`);
    await call('POST', `/ai/forecasts/${id}/override`, {
      quantity: 2500,
      justification: 'Reviewed demo production plan',
    });
  }
  await new Promise<void>((resolve) => {
    const socket = new WebSocket(
      base.replace('http', 'ws').replace('/api/v1', '') + '/realtime/?EIO=4&transport=websocket',
    );
    const timer = setTimeout(() => {
      check('Real WebSocket authenticates demo user', false, 'timeout');
      socket.close();
      resolve();
    }, 10000);
    socket.onmessage = (event) => {
      const value = String(event.data);
      if (value.startsWith('0')) socket.send('40' + JSON.stringify({ token }));
      if (value.startsWith('40')) {
        check('Real WebSocket authenticates demo user', true);
        clearTimeout(timer);
        socket.close();
        resolve();
      }
    };
    socket.onerror = () => {
      clearTimeout(timer);
      check('Real WebSocket authenticates demo user', false, 'connection error');
      resolve();
    };
  });
  await call('GET', '/inventory/items', undefined, [401], 'broken.token.signature');
  const jsonBad = await fetch(base + '/inventory/items', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{"broken":',
  });
  check('Malformed JSON returns 400', jsonBad.status === 400, jsonBad.status);
  const huge = await fetch(base + '/inventory/items', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'x'.repeat(1100000) }),
  });
  check('Oversize JSON returns 413', huge.status === 413, huge.status);
  await call('GET', '/inventory/items', undefined, [403], token, {
    Origin: 'https://untrusted.invalid',
  });
  const tag = randomUUID().slice(0, 8);
  const wc = (
    await call('POST', '/inventory/warehouses', {
      name: 'Temporary audit store',
      code: `QA-${tag}`,
    })
  ).data;
  await call('GET', `/inventory/warehouses/${wc.id}`);
  await call('PATCH', `/inventory/warehouses/${wc.id}`, { name: 'Audit renamed' });
  await call('DELETE', `/inventory/warehouses/${wc.id}`);
  const cat = (await call('POST', '/inventory/categories', { name: `QA ${tag}` })).data;
  await call('GET', `/inventory/categories/${cat.id}`);
  await call('PATCH', `/inventory/categories/${cat.id}`, {
    description: 'Audit temporary category',
  });
  await call('DELETE', `/inventory/categories/${cat.id}`);
  const temp = (
    await call('POST', '/inventory/items', {
      sku: `QA-${tag}`,
      name: 'Temporary audit item',
      unit: 'kg',
      type: 'raw_material',
      movingAverageCost: 10,
    })
  ).data;
  await call('PATCH', `/inventory/items/${temp.id}`, { description: 'Updated through HTTP' });
  const before = (await scope(() =>
    StockBalance.findOne({ itemId: item.id, warehouseId: wh.id }).lean().exec(),
  ))!.quantity;
  const key = randomUUID(),
    adjust = { warehouseId: wh.id, quantityDelta: 1, reasonCode: 'recount' };
  await call('POST', `/inventory/items/${item.id}/adjust`, adjust, [200], token, {
    'Idempotency-Key': key,
  });
  await call(
    'POST',
    `/inventory/items/${item.id}/adjust`,
    { ...adjust, quantityDelta: 2 },
    [409],
    token,
    { 'Idempotency-Key': key },
  );
  const after = (await scope(() =>
    StockBalance.findOne({ itemId: item.id, warehouseId: wh.id }).lean().exec(),
  ))!.quantity;
  check('Idempotency rejects changed payload without extra stock', after === before + 1, {
    before,
    after,
  });
  await call('POST', `/inventory/items/${temp.id}/adjust`, {
    warehouseId: wh.id,
    quantityDelta: 10,
    reasonCode: 'opening',
  });
  const race = await Promise.all(
    [1, 2].map(() =>
      call(
        'POST',
        `/inventory/items/${temp.id}/adjust`,
        { warehouseId: wh.id, quantityDelta: -8, reasonCode: 'production_consume' },
        [200, 400, 409],
      ),
    ),
  );
  const remaining = await scope(() => StockBalance.findOne({ itemId: temp.id }).lean().exec());
  check(
    'Concurrent deductions never overspend stock',
    race.filter((r) => r.status === 200).length === 1 && remaining?.quantity === 2,
    { statuses: race.map((x) => x.status), quantity: remaining?.quantity },
  );
  await call(
    'POST',
    `/inventory/items/${temp.id}/transfer`,
    { fromWarehouseId: wh.id, toWarehouseId: wh.id, quantity: 1 },
    [400],
  );
  const atomicSku = `ATOMIC-${tag}`;
  const bulk = await call('POST', '/inventory/bulk-import', {
    atomic: true,
    items: [
      { sku: atomicSku, name: 'Must roll back', unit: 'kg', type: 'raw_material' },
      { sku: item.sku, name: 'Duplicate fails second row', unit: 'kg', type: 'raw_material' },
    ],
  });
  const rolledBack = await scope(() => Item.findOne({ sku: atomicSku }).lean().exec());
  check('Atomic bulk import rolls back earlier rows', !rolledBack && bulk.data.imported === 0);
  await call('POST', '/inventory/bulk-import', {
    atomic: false,
    items: [
      {
        sku: `BULK-${tag}`,
        name: 'Imported audit consumable',
        unit: 'pcs',
        type: 'consumable',
        openingBalance: { warehouseCode: wh.code, quantity: 50, unitCost: 10 },
      },
      { sku: item.sku, name: 'Skipped duplicate', unit: 'kg', type: 'raw_material' },
    ],
  });
  await call('GET', `/suppliers/${sid}`);
  await call('PATCH', `/suppliers/${sid}`, { tradingName: 'Meghna Demo - Verified' });
  await call('GET', `/suppliers/${sid}/performance`);
  await call('GET', `/suppliers/compare?ids=${sid},${m.suppliers[1].id}`);
  await call('POST', `/suppliers/${sid}/contacts`, {
    name: 'QA Contact',
    email: 'audit@garments.example.test',
    isPrimary: false,
  });
  await call('PATCH', `/suppliers/${sid}/contacts/1`, { designation: 'QA Officer' });
  await call('DELETE', `/suppliers/${sid}/contacts/1`);
  const dummy = (await call('POST', '/suppliers', { legalName: `Archive Supplier ${tag}` })).data;
  await call('DELETE', `/suppliers/${dummy.id}`);
  const po = (
    await call('POST', '/purchase-orders', {
      supplierId: sid,
      warehouseId: wh.id,
      currency: 'BDT',
      expectedDeliveryAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      lines: [{ itemId: item.id, quantityOrdered: 10, unitPrice: 480 }],
    })
  ).data;
  await call('PATCH', `/purchase-orders/${po.id}`, { paymentTermsDays: 45 });
  const taxed = await call('PATCH', `/purchase-orders/${po.id}`, { taxRate: 0.1 });
  check(
    'Tax-only PO update recalculates totals',
    taxed.data.totals.tax === 480 && taxed.data.totals.total === 5280,
    taxed.data.totals,
  );
  const revised = await call('PATCH', `/purchase-orders/${po.id}`, {
    warehouseId: wh.id,
    currency: 'BDT',
    expectedDeliveryAt: new Date(Date.now() + 10 * 86400000).toISOString(),
    taxRate: 0.05,
    lines: [
      {
        itemId: item.id,
        quantityOrdered: 10,
        unitPrice: 480,
        remarks: 'Revised offer',
        expectedDeliveryAt: new Date(Date.now() + 10 * 86400000).toISOString(),
      },
    ],
  });
  po.lines = revised.data.lines;
  check(
    'Line and tax PO revision uses the supplied tax rate',
    revised.data.totals.tax === 240,
    revised.data.totals,
  );
  await call('POST', `/purchase-orders/${po.id}/approve`, {}, [409]);
  await call('POST', `/purchase-orders/${po.id}/close`, {}, [409]);
  await call('POST', `/purchase-orders/${po.id}/submit`, {});
  await call('POST', `/purchase-orders/${po.id}/approve`, {});
  await call('POST', `/purchase-orders/${po.id}/send`, { sentTo: 'sales0@garments.example.test' });
  const rl = { poLineId: po.lines[0].id, itemId: item.id, quantity: 6, unitCost: 480 };
  await call(
    'POST',
    `/purchase-orders/${po.id}/receipts`,
    { warehouseId: wh.id, lines: [{ ...rl, itemId: m.items[1].id }] },
    [400],
  );
  await call(
    'POST',
    `/purchase-orders/${po.id}/receipts`,
    { warehouseId: wh.id, lines: [rl, rl] },
    [400],
  );
  const pr = await Promise.all(
    [1, 2].map(() =>
      call(
        'POST',
        `/purchase-orders/${po.id}/receipts`,
        { warehouseId: wh.id, lines: [rl] },
        [200, 201, 400, 409],
      ),
    ),
  );
  const stored = await scope(() => PurchaseOrder.findById(po.id).lean().exec());
  check(
    'Concurrent receipts do not over-receive',
    pr.filter((x) => x.status === 201).length === 1 && stored!.lines[0]!.quantityReceived === 6,
    pr.map((x) => x.status),
  );
  await call('GET', `/purchase-orders/${po.id}/receipts`);
  await call('POST', `/purchase-orders/${po.id}/receipts`, {
    warehouseId: wh.id,
    lines: [{ ...rl, quantity: 4 }],
  });
  await call('POST', `/purchase-orders/${po.id}/close`, {});
  await call(
    'POST',
    `/purchase-orders/${po.id}/cancel`,
    { reason: 'Cannot cancel a closed PO' },
    [409],
  );
  await call('PATCH', `/purchase-orders/${po.id}`, { paymentTermsDays: 60 }, [409]);
  const rejected = (
    await call('POST', '/purchase-orders', {
      supplierId: sid,
      warehouseId: wh.id,
      expectedDeliveryAt: new Date(Date.now() + 86400000).toISOString(),
      lines: [{ itemId: item.id, quantityOrdered: 10, unitPrice: 480 }],
    })
  ).data;
  await call(
    'POST',
    `/purchase-orders/${rejected.id}/reject`,
    { reason: 'Invalid draft rejection' },
    [409],
  );
  await call('POST', `/purchase-orders/${rejected.id}/submit`, {});
  await call('POST', `/purchase-orders/${rejected.id}/reject`, { reason: 'Buyer budget review' });
  const revisedReject = await call('PATCH', `/purchase-orders/${rejected.id}`, {
    paymentTermsDays: 45,
  });
  check('Rejected PO revision returns to draft', revisedReject.data.state === 'draft');
  await call('POST', `/purchase-orders/${rejected.id}/cancel`, {
    reason: 'Buyer cancelled revised style',
  });
  await call(
    'POST',
    '/purchase-orders/from-forecast',
    { itemId: m.items[10].id, warehouseId: m.warehouses[1].id },
    [201],
  );
  const pdf = (await call('GET', `/purchase-orders/${po.id}/pdf`)).data;
  if (pdf.url && !pdf.url.startsWith('stub:')) {
    const r = await fetch(pdf.url);
    const b = Buffer.from(await r.arrayBuffer());
    check(
      'Real R2 PO PDF downloads with valid PDF header',
      r.ok && b.subarray(0, 4).toString() === '%PDF',
      { status: r.status, size: b.length },
    );
    if (r.ok) await writeFile('artifacts/presentation-po.pdf', b);
  } else check('Real R2 PO PDF download', false, pdf);
  const form = new FormData();
  form.append('kind', 'pdf');
  form.append(
    'file',
    new Blob([await readFile('artifacts/presentation-po.pdf')], { type: 'application/pdf' }),
    'demo-po.pdf',
  );
  const upload = (await call('POST', '/uploads', form)).data;
  check('File upload stored in real object storage', upload.uploaded === true, upload.uploaded);
  if (upload.url) {
    const r = await fetch(upload.url);
    check('Uploaded file downloads', r.ok, r.status);
  }
  const doc = new FormData();
  doc.append('kind', 'cert');
  doc.append(
    'file',
    new Blob([await readFile('artifacts/presentation-po.pdf')], { type: 'application/pdf' }),
    'demo-document.pdf',
  );
  await call('POST', `/suppliers/${sid}/documents`, doc);
  await call('DELETE', `/suppliers/${sid}/documents/0`);
  const badFile = new FormData();
  badFile.append('kind', 'pdf');
  badFile.append(
    'file',
    new Blob(['<script>wrong type</script>'], { type: 'application/pdf' }),
    'fake.pdf',
  );
  await call('POST', '/uploads', badFile, [400, 415]);
  const rfq = (
    await call('POST', '/quotations', {
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      lines: [{ itemId: item.id, quantity: 100 }],
      invitedSuppliers: [{ supplierId: sid, contactEmail: 'sales0@garments.example.test' }],
    })
  ).data;
  const raw = await scope(() => QuotationRequest.findById(rfq.id).lean().exec());
  const qt = raw!.supplierInvitations[0]!.responseToken;
  const offer = {
    lines: [
      {
        itemId: item.id,
        unitPrice: 450,
        currency: 'BDT',
        moq: 10,
        leadTimeDays: 7,
        validityDays: 14,
      },
    ],
  };
  await call(
    'POST',
    `/public/quotations/responses/${qt}`,
    { lines: [{ ...offer.lines[0], itemId: m.items[1].id }] },
    [400],
    '',
  );
  await call(
    'POST',
    `/public/quotations/responses/${qt}`,
    { lines: [offer.lines[0], offer.lines[0]] },
    [400],
    '',
  );
  await call('POST', `/public/quotations/responses/${qt}`, offer, [200], '');
  await call('POST', `/public/quotations/responses/${qt}`, offer, [409], '');
  await call('GET', `/quotations/${rfq.id}`);
  await call('GET', `/quotations/${rfq.id}/compare`);
  await call('POST', `/quotations/${rfq.id}/accept`, { supplierId: sid, warehouseId: wh.id });
  await call(
    'POST',
    `/quotations/${rfq.id}/accept`,
    { supplierId: sid, warehouseId: wh.id },
    [409],
  );
  await call('POST', `/quotations/${rfq.id}/cancel`, {}, [409]);
  await call('POST', '/public/quotations/responses/invalid-token-123456789', offer, [401], '');
  const owner = await scope(() =>
    User.findOne({ email: m.users.owner }).select('+emailVerifyToken').lean().exec(),
  );
  if (owner?.emailVerifyToken)
    await call('POST', '/auth/verify-email', { token: owner.emailVerifyToken }, [200], '');
  const invite = (
    await call('POST', '/auth/invite', {
      email: `invite.${tag}@garments.example.test`,
      fullName: 'Audit Invited User',
      role: 'viewer',
    })
  ).data;
  const invited = await scope(() =>
    User.findById(invite.id).select('+emailVerifyToken').lean().exec(),
  );
  await call(
    'POST',
    '/auth/accept-invite',
    { token: invited!.emailVerifyToken, password: m.password },
    [200],
    '',
  );
  const invitedLogin = await call(
    'POST',
    '/auth/login',
    { email: invited!.email, password: m.password },
    [200],
    '',
  );
  await call('PATCH', `/auth/users/${invite.id}/role`, { role: 'warehouse_staff' });
  await call('GET', '/auth/me', undefined, [401], invitedLogin.data.accessToken);
  await new Promise((r) => setTimeout(r, 1100));
  const invitedNew = await call(
    'POST',
    '/auth/login',
    { email: invited!.email, password: m.password },
    [200],
    '',
  );
  await call(
    'POST',
    '/auth/change-password',
    { currentPassword: m.password, newPassword: 'ChangedDemo!2026' },
    [200],
    invitedNew.data.accessToken,
  );
  await call('GET', '/auth/me', undefined, [401], invitedNew.data.accessToken);
  await call('DELETE', `/auth/users/${invite.id}`);
  await call(
    'POST',
    '/auth/login',
    { email: invited!.email, password: 'ChangedDemo!2026' },
    [403],
    '',
  );
  await call('POST', '/auth/forgot-password', { email: m.users.viewer }, [200], '');
  await new Promise((r) => setTimeout(r, 2000));
  const mailFiles = (await readdir('.demo-data/mail')).sort().reverse();
  let reset = '';
  for (const file of mailFiles) {
    const txt = await readFile(`.demo-data/mail/${file}`, 'utf8');
    if (txt.includes(m.users.viewer) && txt.includes('reset-password')) {
      const decoded = txt
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-F]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
      reset = decoded.match(/reset-password\?token=([^\s"<]+)/)?.[1] ?? '';
      if (reset) break;
    }
  }
  check('Password reset token received over real local SMTP', !!reset);
  if (reset) {
    await call(
      'POST',
      '/auth/reset-password',
      { token: decodeURIComponent(reset), newPassword: m.password },
      [200],
      '',
    );
    await new Promise((r) => setTimeout(r, 1100));
  }
  const session = await call(
    'POST',
    '/auth/login',
    { email: m.users.viewer, password: m.password },
    [200],
    '',
  );
  const refresh = await call('POST', '/auth/refresh', {}, [200], '', {
    Cookie: session.cookies,
    'X-CSRF': 'test-csrf-header',
  });
  await call('POST', '/auth/refresh', {}, [401], '', {
    Cookie: session.cookies,
    'X-CSRF': 'test-csrf-header',
  });
  await call('POST', '/auth/refresh', {}, [401], '', {
    Cookie: refresh.cookies,
    'X-CSRF': 'test-csrf-header',
  });
  const fresh = await call(
    'POST',
    '/auth/login',
    { email: m.users.viewer, password: m.password },
    [200],
    '',
  );
  await call('POST', '/auth/logout', {}, [204], '', { Cookie: fresh.cookies });
  await call('POST', '/auth/refresh', {}, [401], '', {
    Cookie: fresh.cookies,
    'X-CSRF': 'test-csrf-header',
  });
  const out = await call(
    'POST',
    '/auth/login',
    { email: m.users.warehouse_staff, password: m.password },
    [200],
    '',
  );
  await call('POST', '/auth/logout-everywhere', {}, [204, 200], out.data.accessToken);
  await call('GET', '/auth/me', undefined, [401], out.data.accessToken);
  await call('POST', '/webhooks/stripe', {}, [501], '');
  await call('POST', '/webhooks/sslcommerz', { tran_id: 'unmatched-demo-test' }, [200], '');
  await call(
    'POST',
    '/billing/checkout-session',
    {
      tier: 'growth',
      gateway: 'stripe',
      successUrl: 'http://localhost:3000/success',
      cancelUrl: 'http://localhost:3000/cancel',
    },
    [501],
  );
  await call(
    'POST',
    '/billing/checkout-session',
    {
      tier: 'trial',
      gateway: 'sslcommerz',
      successUrl: 'http://localhost:3000/success',
      cancelUrl: 'http://localhost:3000/cancel',
    },
    [400],
  );
  await call('POST', '/billing/subscription/change', { tier: 'growth' }); // retain the presentation plan
  if (!env.SSLCOMMERZ_IS_LIVE) {
    const checkout = await call(
      'POST',
      '/billing/checkout-session',
      {
        tier: 'growth',
        gateway: 'sslcommerz',
        successUrl: 'http://localhost:3000/success',
        cancelUrl: 'http://localhost:3000/cancel',
      },
      [200],
    );
    check(
      'Real SSLCommerz sandbox checkout URL',
      typeof checkout.data.redirectUrl === 'string' &&
        checkout.data.redirectUrl.includes('sslcommerz'),
      checkout.data.redirectUrl?.split('?')[0],
    );
    await call('POST', '/billing/subscription/cancel', { cancelImmediately: false });
    await scope(() =>
      Subscription.updateOne(
        { tenantId },
        { $set: { cancelAtPeriodEnd: false, scheduledTier: null } },
      ).exec(),
    );
  }
  for (let i = 1; i < m.suppliers.length; i++) {
    const it = m.items[i * 2];
    const additional = (
      await call('POST', '/purchase-orders', {
        supplierId: m.suppliers[i].id,
        warehouseId: m.warehouses[i % 3].id,
        currency: 'BDT',
        expectedDeliveryAt: new Date(Date.now() + (i === 7 ? -10 : 7 + i) * 86400000).toISOString(),
        paymentTermsDays: 30 + i * 5,
        lines: [{ itemId: it.id, quantityOrdered: 200 + i * 50, unitPrice: it.movingAverageCost }],
      })
    ).data;
    await call('POST', `/purchase-orders/${additional.id}/submit`, {});
    await call('POST', `/purchase-orders/${additional.id}/approve`, {});
    await call('POST', `/purchase-orders/${additional.id}/send`, {
      sentTo: `sales${i}@garments.example.test`,
    });
    if (i % 2 === 0)
      await call('POST', `/purchase-orders/${additional.id}/receipts`, {
        warehouseId: m.warehouses[i % 3].id,
        lines: [
          {
            poLineId: additional.lines[0].id,
            itemId: it.id,
            quantity: 100,
            unitCost: it.movingAverageCost,
          },
        ],
      });
  }
  // Repair only failed provider attempts; retain original failure history.
  const ctx: any = {
    tenantId,
    userId: new Types.ObjectId(owner!._id),
    role: 'owner',
    subscriptionTier: 'growth',
    seats: 15,
    features: new Set(),
    requestId: `regression-${tag}`,
  };
  const failed = await scope(() => Forecast.find({ 'provenance.fallback': true }).lean().exec());
  for (const f of failed) {
    let good: any;
    for (let attempt = 0; attempt < 4; attempt++) {
      good = await scope(() =>
        aiService.runForecastForItem({
          ctx,
          itemId: f.itemId,
          horizonDays: f.horizonDays,
          skipRateLimit: true,
          skipReadCache: true,
        }),
      );
      if (!good.provenance.fallback && good.rawResponse) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    check(
      `Live AI recovery ${f.itemId}/${f.horizonDays}`,
      !!good?.rawResponse && !good?.provenance.fallback,
    );
  }
  for (const [name, queue] of [
    ['forecast', forecastQueue],
    ['report', reportQueue],
    ['scheduled', scheduledQueue],
  ] as const) {
    const events = new QueueEvents(queue.name, {
      connection: redisQueue,
      prefix: env.QUEUE_PREFIX,
    });
    await events.waitUntilReady();
    try {
      let job: any;
      if (name === 'forecast') {
        const r = await call('POST', '/ai/forecasts/batch', {
          itemIds: [m.items[12].id, m.items[13].id],
        });
        job = await queue.getJob(r.data.batchJobId);
      } else if (name === 'report')
        job = await reportQueue.add('report.weekly_digest', {
          tenantId: m.tenantId,
          weekStart: new Date(Date.now() - 7 * 86400000).toISOString(),
          weekEnd: new Date().toISOString(),
        });
      else
        job = await scheduledQueue.add('scheduled.quotation.expiry_check', {
          tenantId: m.tenantId,
          quotationId: rfq.id,
        });
      const output = await job.waitUntilFinished(events, 180000);
      check(`Real ${name} worker finishes queued job`, output?.ok === true, output);
      if (name === 'report')
        check(
          'Weekly AI report renders PDF and reaches SMTP',
          output?.pdfRendered === true && output?.emailSent === true,
          output,
        );
    } catch (err) {
      check(`Real ${name} worker finishes queued job`, false, (err as Error).message);
    } finally {
      await events.close();
    }
  }
  const artifactResult = await call('GET', '/reports/artifacts');
  const readyArtifact = artifactResult.data.find((a: any) => a.status === 'ready');
  check('Weekly AI PDF is persisted as a ready report artifact', !!readyArtifact);
  if (readyArtifact) {
    const download = await call('GET', `/reports/artifacts/${readyArtifact._id}/download`);
    const r = await fetch(download.data.url);
    const bytes = Buffer.from(await r.arrayBuffer());
    check(
      'Weekly report downloads from real R2 storage',
      r.ok && bytes.subarray(0, 4).toString() === '%PDF',
    );
    if (r.ok) await writeFile('artifacts/presentation-weekly-report.pdf', bytes);
  }
  await call(
    'POST',
    '/reports/weekly-digest',
    { from: new Date(Date.now() - 7 * 86400000).toISOString(), to: new Date().toISOString() },
    [202],
  );
  await scope(async () => {
    await Item.updateMany(
      { categoryId: m.categories[3].id },
      { $set: { type: 'packaging' } },
    ).exec();
    await Item.updateMany(
      { categoryId: m.categories[4].id },
      { $set: { type: 'consumable' } },
    ).exec();
    for (const it of m.items) {
      if (it.categoryId === m.categories[3].id) it.type = 'packaging';
      if (it.categoryId === m.categories[4].id) it.type = 'consumable';
    }
    const sums = await StockMovement.aggregate([
      {
        $group: {
          _id: { itemId: '$itemId', warehouseId: '$warehouseId' },
          quantity: { $sum: '$quantity' },
        },
      },
    ]);
    const bs = await StockBalance.find().lean().exec();
    check(
      'Final ledger/balance reconciliation',
      bs.every(
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
    const fs = await Forecast.find().lean().exec();
    const insights = await AiInsight.find().lean().exec();
    const deliveries = await EmailDelivery.find().lean().exec();
    const entries = bs.map((b) => {
      const it = m.items.find((x: any) => x.id === String(b.itemId));
      const unitCost = it?.movingAverageCost ?? 10;
      return {
        itemId: b.itemId,
        warehouseId: b.warehouseId,
        quantity: b.quantity,
        unitCost,
        valueBdt: b.quantity * unitCost,
      };
    });
    const totalValue = entries.reduce((sum, e) => sum + e.valueBdt, 0),
      totalQuantity = entries.reduce((sum, e) => sum + e.quantity, 0);
    const periodStart = new Date();
    periodStart.setUTCDate(1);
    periodStart.setUTCHours(0, 0, 0, 0);
    await StockSnapshot.findOneAndUpdate(
      { periodStart },
      {
        $set: {
          periodEnd: new Date(),
          entries,
          totalValueBdt: totalValue,
          totalQuantity,
          computedAt: new Date(),
        },
      },
      { upsert: true, runValidators: true },
    );
    const pos = await PurchaseOrder.find().lean().exec();
    await KpiSnapshot.findOneAndUpdate(
      { period: 'month', periodStart },
      {
        $set: {
          periodEnd: new Date(),
          computedAt: new Date(),
          inventory: {
            itemCount: await Item.countDocuments(),
            totalQuantity,
            totalValueBdt: totalValue,
            movementCount: await StockMovement.countDocuments(),
            lowStockItemCount: bs.filter((b) => b.lowStockSince).length,
          },
          procurement: {
            poCount: pos.length,
            draftPoCount: pos.filter((p) => p.state === 'draft').length,
            pendingApprovalCount: pos.filter((p) => p.state === 'pending_approval').length,
            approvedPoCount: pos.filter((p) => p.state === 'approved').length,
            closedPoCount: pos.filter((p) => p.state === 'closed').length,
            spendBdt: pos
              .filter((p) =>
                ['approved', 'sent', 'partially_received', 'fully_received', 'closed'].includes(
                  p.state,
                ),
              )
              .reduce((sum, p) => sum + p.totals.total, 0),
            uniqueSupplierCount: new Set(pos.map((p) => String(p.supplierId))).size,
          },
          supplier: { activeSupplierCount: m.suppliers.length },
          ai: {
            forecastCount: fs.length,
            failoverCount: fs.filter((f) => f.provenance.failoverInvoked).length,
            averageForecastLatencyMs:
              fs.reduce((s, f) => s + f.provenance.latencyMs, 0) / Math.max(1, fs.length),
          },
          narrative: insights.find((i) => i.kind === 'procurement_brief')?.response ?? null,
        },
      },
      { upsert: true, runValidators: true },
    );
    const invoices = await Invoice.find({ number: { $regex: '^DEMO-' } })
      .lean()
      .exec();
    for (const inv of invoices)
      await PaymentAttempt.findOneAndUpdate(
        { gatewayPaymentIntentId: `DEMO-${inv._id}` },
        {
          $set: {
            invoiceId: inv._id,
            subscriptionId: inv.subscriptionId,
            amount: inv.amountTotal,
            currency: inv.currency,
            gateway: 'sslcommerz',
            gatewayPaymentIntentId: `DEMO-${inv._id}`,
            status:
              inv.status === 'paid' ? 'succeeded' : inv.status === 'failed' ? 'failed' : 'pending',
            attemptedAt: inv.issuedAt,
            resolvedAt: inv.paidAt,
            gatewayResponseSummary: {
              synthetic: true,
              note: 'Presentation fixture; not a real gateway settlement',
            },
          },
        },
        { upsert: true, runValidators: true },
      );
    check(
      'Real AI responses persisted for presentation',
      fs.filter((f) => !f.provenance.fallback && f.rawResponse).length >= 36,
      fs.length,
    );
    check('AI text responses persisted for presentation', insights.length >= 12, insights.length);
    check(
      'Email delivery states persisted from real SMTP',
      deliveries.some((d) => d.state === 'delivered'),
      deliveries.length,
    );
    m.finalCounts = {
      items: await Item.countDocuments(),
      stockMovements: await StockMovement.countDocuments(),
      stockBalances: bs.length,
      purchaseOrders: await PurchaseOrder.countDocuments(),
      forecasts: fs.length,
      liveAiForecasts: fs.filter((f) => !f.provenance.fallback && f.rawResponse).length,
      aiInsights: insights.length,
      emailDeliveries: deliveries.length,
    };
    await writeFile(
      'artifacts/persisted-ai-responses.json',
      JSON.stringify({ forecasts: fs.filter((f) => !f.provenance.fallback), insights }, null, 2),
    );
  });
  await writeFile('artifacts/garments-demo-manifest.json', JSON.stringify(m, null, 2));
}
export const regressionDone = main()
  .catch((err) => {
    check('Regression runner completed', false, err.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    await writeFile(
      'artifacts/real-regression-results.json',
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          passed: results.filter((x) => x.pass).length,
          failed: results.filter((x) => !x.pass).length,
          results,
        },
        null,
        2,
      ),
    );
    if (process.env.REGRESSION_EMBEDDED !== '1') {
      await closeQueues();
      await disconnectRedis();
      await mongoose.disconnect();
    }
    console.log(
      `RESULT ${results.filter((x) => x.pass).length} passed, ${results.filter((x) => !x.pass).length} failed`,
    );
    if (results.some((x) => !x.pass)) process.exitCode = 1;
  });
