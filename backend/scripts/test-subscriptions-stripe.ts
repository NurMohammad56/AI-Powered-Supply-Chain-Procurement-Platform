import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { SMTPServer } from 'smtp-server';
import { Types } from 'mongoose';
import { createApp } from '../src/app.js';
import { billingService } from '../src/modules/billing/billing.service.js';
let pendingWebhooks = 0;
const originalWebhook = billingService.ingestWebhook.bind(billingService);
billingService.ingestWebhook = async (args) => {
  pendingWebhooks++;
  try {
    return await originalWebhook(args);
  } finally {
    pendingWebhooks--;
  }
};
async function drainWebhooks() {
  const deadline = Date.now() + 120_000;
  while (pendingWebhooks && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(pendingWebhooks, 0, 'Webhook work must finish before disconnecting dependencies');
}
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { connectRedis, disconnectRedis } from '../src/config/redis.js';
import { tenantStorage } from '../src/shared/db/tenancyPlugin.js';
import { closeQueues } from '../src/shared/queue/queues.js';
import { startEmailWorker } from '../src/workers/email.worker.js';
import { stripeClient } from '../src/modules/billing/stripe.client.js';
import { Subscription } from '../src/modules/billing/models/subscription.model.js';
import {
  CheckoutOrder,
  StripeEventReceipt,
} from '../src/modules/billing/models/checkoutOrder.model.js';
import { Invoice } from '../src/modules/billing/models/invoice.model.js';
import { PaymentAttempt } from '../src/modules/billing/models/paymentAttempt.model.js';
import { User } from '../src/modules/auth/models/user.model.js';
import { aiService } from '../src/modules/ai/ai.service.js';
import { generateWeeklyReport } from '../src/modules/ai/reportGenerator.js';

type Tenant = { id: Types.ObjectId; email: string; token: string; ownerId: string; label: string };
const checks: Array<{ name: string; pass: boolean }> = [];
const plans: any[] = [],
  tenants: Tenant[] = [],
  mail: Array<{ to: string; body: string }> = [];
const webhooks: Array<{ body: Buffer; signature: string; event: any }> = [];
const suffix = Date.now().toString(36),
  password = 'SubscriptionQA!2026';
let base = '',
  browser: Browser | undefined,
  listener: ChildProcess | undefined;
let worker: ReturnType<typeof startEmailWorker> | undefined;
const api = stripeClient();
const scope = <T>(tenant: Tenant, fn: () => Promise<T>) =>
  tenantStorage.run({ tenantId: tenant.id }, fn);
function pass(name: string, condition: unknown) {
  assert.ok(condition, name);
  checks.push({ name, pass: true });
  console.log(`PASS ${name}`);
}
async function waitFor<T>(
  name: string,
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 120_000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) {
      pass(name, true);
      return value;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timeout: ${name}`);
}
async function request(
  tenant: Tenant | undefined,
  method: string,
  path: string,
  body?: any,
  expected = 200,
  key = randomUUID(),
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      ...(tenant ? { Authorization: `Bearer ${tenant.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const payload: any = response.status === 204 ? {} : await response.json();
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: ${response.status} ${payload.error?.code ?? ''} ${payload.error?.message ?? ''}`,
  );
  return payload.data;
}
async function register(label: string, verify = true): Promise<Tenant> {
  const email = `${label}-${suffix}@stripe-qa.example.test`;
  const registration = await request(
    undefined,
    'POST',
    '/auth/register',
    {
      factory: { name: `Stripe QA ${label} ${suffix}`, businessType: 'rmg' },
      owner: { fullName: `QA ${label} Owner`, email, password },
    },
    201,
  );
  const login = await request(undefined, 'POST', '/auth/login', { email, password });
  const tenant: Tenant = {
    id: new Types.ObjectId(registration.factory.id),
    email,
    token: login.accessToken,
    ownerId: registration.owner.id,
    label,
  };
  tenants.push(tenant);
  if (verify) await verifyTenant(tenant);
  return tenant;
}
async function emailToken(email: string, after = 0) {
  const found = await waitFor(
    `Verification/invite email arrives for ${email.split('@')[0]}`,
    async () =>
      mail
        .slice(after)
        .filter((entry) => entry.to === email)
        .at(-1),
    (entry) => !!entry?.body.match(/[?&]token=([A-Za-z0-9_-]+)/),
  );
  return found!.body.match(/[?&]token=([A-Za-z0-9_-]+)/)![1]!;
}
async function verifyTenant(tenant: Tenant) {
  const token = await emailToken(tenant.email);
  await request(undefined, 'POST', '/auth/verify-email', { token });
}
const subscription = (tenant: Tenant) => scope(tenant, () => Subscription.findOne().lean().exec());
const webhookPath = '/webhooks/stripe';
const server = createServer((req, res) => {
  if (req.url === '/api/v1' + webhookPath) {
    const parts: Buffer[] = [];
    req.on('data', (chunk) => parts.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      try {
        webhooks.push({
          body,
          signature: String(req.headers['stripe-signature'] ?? ''),
          event: JSON.parse(body.toString()),
        });
      } catch {}
    });
  }
  app(req, res);
});
const app = createApp();
const smtp = new SMTPServer({
  secure: false,
  disabledCommands: ['STARTTLS'],
  onAuth(auth, _session, cb) {
    cb(
      auth.username === 'demo' && auth.password === 'demo'
        ? null
        : new Error('Invalid QA SMTP credentials'),
      { user: 'demo' },
    );
  },
  onData(stream, session, cb) {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const decoded = raw
        .replace(/=\r?\n/g, '')
        .replace(/=([A-Fa-f\d]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
      for (const address of session.envelope.rcptTo)
        mail.push({ to: address.address, body: decoded });
      void mkdir('.demo-data/mail', { recursive: true })
        .then(() => writeFile(`.demo-data/mail/stripe-qa-${Date.now()}-${randomUUID()}.eml`, raw))
        .then(() => cb(), cb);
    });
  },
});
async function fill(page: Page, selectors: string[], value: string, required = true) {
  for (const frame of [page.mainFrame()])
    for (const selector of selectors) {
      const input = await frame.$(selector);
      if (!input || !(await input.isVisible())) continue;
      await input.click({ clickCount: 3 });
      await input.type(value, { delay: 30 });
      return true;
    }
  if (required) throw new Error(`Missing checkout input: ${selectors.join(',')}`);
  return false;
}
async function payCheckout(url: string, label: string, sessionId: string) {
  const page = await browser!.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setRequestInterception(true);
  page.on('request', (req) =>
    req.url().startsWith(env.FRONTEND_BASE_URL)
      ? void req.respond({
          status: 200,
          contentType: 'text/html',
          body: '<h1>Stripe QA return page</h1>',
        })
      : void req.continue(),
  );
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 90_000 });
  await page
    .waitForSelector('#cardNumber', { visible: true, timeout: 45_000 })
    .catch(async (err) => {
      await page.screenshot({ path: `artifacts/stripe-${label}-form.png`, fullPage: true });
      console.log(
        'Checkout form input descriptors:',
        JSON.stringify(
          await page.$$eval('input', (nodes) =>
            nodes.map((n) => ({ name: n.name, id: n.id, placeholder: n.placeholder })),
          ),
        ),
      );
      throw err;
    });
  pass(`Hosted ${label} checkout displays card fields`, true);
  await fill(
    page,
    ['input[name="cardNumber"]', '#cardNumber', 'input[autocomplete="cc-number"]'],
    '4242424242424242',
  );
  await fill(
    page,
    ['input[name="cardExpiry"]', '#cardExpiry', 'input[autocomplete="cc-exp"]'],
    '1234',
  );
  await fill(page, ['input[name="cardCvc"]', '#cardCvc', 'input[autocomplete="cc-csc"]'], '123');
  await fill(
    page,
    ['input[name="billingName"]', '#billingName', 'input[autocomplete="cc-name"]'],
    'Bangladesh Garments QA',
  );
  for (const frame of [page.mainFrame()]) {
    for (const selector of [
      'select[name="billingCountry"]',
      '#billingCountry',
      'select[autocomplete="country"]',
    ]) {
      const select = await frame.$(selector);
      if (select) {
        await select.select('US');
        break;
      }
    }
  }
  await fill(
    page,
    ['input[name="billingPostalCode"]', '#billingPostalCode', 'input[autocomplete="postal-code"]'],
    '10001',
    false,
  );
  await page.screenshot({ path: `artifacts/stripe-${label}-checkout.png`, fullPage: true });
  const submit = await page.$('button[type="submit"]');
  assert.ok(submit, 'Checkout submit button');
  await submit.click();
  await waitFor(
    `Real Stripe Checkout ${label} payment completes`,
    () => api.checkout.sessions.retrieve(sessionId),
    (row) => row.payment_status === 'paid',
    120_000,
  ).catch(async (error) => {
    await page.screenshot({ path: `artifacts/stripe-${label}-payment-error.png`, fullPage: true });
    console.log(
      'Checkout visible message:',
      (await page.$eval('body', (body) => body.innerText)).slice(-1500),
    );
    throw error;
  });
  await page.close();
}
async function checkout(tenant: Tenant, tier: 'starter' | 'growth' | 'enterprise') {
  const result = await request(tenant, 'POST', '/billing/checkout-session', {
    tier,
    successUrl: env.FRONTEND_BASE_URL + '/billing/success?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: env.FRONTEND_BASE_URL + '/billing/cancel',
  });
  const session = await api.checkout.sessions.retrieve(result.sessionId);
  pass(
    `${tier}: checkout uses Stripe test mode and subscription mode`,
    !session.livemode && session.mode === 'subscription',
  );
  pass(
    `${tier}: checkout alone does not activate paid access`,
    (await subscription(tenant))!.tier === 'trial',
  );
  await payCheckout(result.redirectUrl, tier, result.sessionId);
  const sub = await waitFor(
    `${tier}: real Stripe CLI webhook activates matching plan`,
    () => subscription(tenant),
    (row) => row?.status === 'active' && row.tier === tier,
  );
  const invoices = await request(tenant, 'GET', '/billing/invoices');
  pass(
    `${tier}: paid invoice persisted`,
    invoices.some((row: any) => row.status === 'paid'),
  );
  pass(
    `${tier}: payment attempt succeeded`,
    !!(await scope(tenant, () => PaymentAttempt.exists({ status: 'succeeded' }).exec())),
  );
  plans.push({
    tier,
    tenantId: tenant.id.toString(),
    sessionId: result.sessionId,
    subscriptionId: sub!.gatewaySubscriptionId,
    status: sub!.status,
  });
  return sub!;
}
async function main() {
  let error: string | undefined;
  try {
    assert.match(env.QUEUE_PREFIX, /^stripe-qa-/);
    assert.match(env.STRIPE_SECRET_KEY, /^sk_test_/);
    assert.ok(env.STRIPE_WEBHOOK_SECRET.startsWith('whsec_'));
    await mkdir('artifacts', { recursive: true });
    await connectDatabase();
    await connectRedis();
    await new Promise<void>((resolve, reject) => {
      smtp.once('error', reject);
      smtp.listen(env.SMTP_PORT, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
    worker = startEmailWorker();
    listener = spawn(
      'stripe',
      [
        'listen',
        '--skip-update',
        '--forward-to',
        base + webhookPath,
        '--events',
        'checkout.session.completed,checkout.session.expired,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed',
      ],
      { env: { ...process.env, STRIPE_API_KEY: env.STRIPE_SECRET_KEY }, windowsHide: true },
    );
    let listenerReady = false;
    for (const stream of [listener.stdout, listener.stderr])
      stream?.on('data', (data: Buffer) => {
        const text = data.toString();
        if (/whsec_/.test(text)) listenerReady = true;
      });
    await waitFor(
      'Actual Stripe CLI webhook listener is ready',
      async () => listenerReady,
      Boolean,
      30_000,
    );
    browser = await puppeteer.launch({
      executablePath: env.CHROMIUM_EXECUTABLE_PATH,
      headless: true,
      args: ['--no-sandbox', '--lang=en-US'],
    });
    const catalogue = await request(undefined, 'GET', '/billing/plans');
    pass(
      'Public pricing exposes all four supported plans and 14-day trial',
      catalogue.plans.length === 4 && catalogue.trialDays === 14,
    );
    pass(
      'Unavailable SSO/audit features are not advertised',
      catalogue.plans.every(
        (p: any) => !p.features.includes('sso') && !p.features.includes('audit_export'),
      ),
    );
    const starter = await register('starter', false);
    const firstToken = await emailToken(starter.email);
    pass(
      'New company atomically gets trial subscription',
      (await subscription(starter))!.tier === 'trial',
    );
    pass(
      'Trial duration is fourteen days',
      Math.abs(
        (await subscription(starter))!.trialEndsAt!.getTime() - Date.now() - 14 * 86400_000,
      ) < 30_000,
    );
    pass(
      'Unverified login is limited to onboarding',
      (await request(starter, 'GET', '/auth/access')).accessMode === 'verification_required',
    );
    await request(starter, 'GET', '/inventory/items', undefined, 403);
    await request(
      starter,
      'POST',
      '/billing/checkout-session',
      {
        tier: 'starter',
        successUrl: env.FRONTEND_BASE_URL + '/ok',
        cancelUrl: env.FRONTEND_BASE_URL + '/cancel',
      },
      403,
    );
    pass('Unverified user cannot access business APIs or checkout', true);
    await request(starter, 'POST', '/billing/trial/restart', {}, 403);
    await request(starter, 'POST', '/auth/resend-verification', {}, 409);
    await scope(starter, () =>
      User.updateOne(
        { _id: starter.ownerId },
        { $set: { emailVerifyTokenExpiresAt: new Date(Date.now() + 24 * 3600_000 - 61_000) } },
      ).exec(),
    );
    const after = mail.length;
    await request(starter, 'POST', '/auth/resend-verification', {});
    const secondToken = await emailToken(starter.email, after);
    await request(undefined, 'POST', '/auth/verify-email', { token: firstToken }, 401);
    await request(undefined, 'POST', '/auth/verify-email', { token: secondToken });
    await request(undefined, 'POST', '/auth/verify-email', { token: secondToken }, 401);
    pass('Resend invalidates old token and verification is one-use', true);
    pass(
      'Existing login token sees fresh verification state',
      (await request(starter, 'GET', '/auth/access')).accessMode === 'full',
    );
    const abandoned = await request(starter, 'POST', '/billing/checkout-session', {
      tier: 'starter',
      successUrl: env.FRONTEND_BASE_URL + '/ok',
      cancelUrl: env.FRONTEND_BASE_URL + '/cancel',
    });
    await api.checkout.sessions.expire(abandoned.sessionId);
    await waitFor(
      'Real expired Checkout webhook releases its pending order',
      () => scope(starter, () => CheckoutOrder.findById(abandoned.orderId).lean().exec()),
      (order) => order?.state === 'expired',
    );
    pass(
      'Abandoned checkout preserves existing trial access',
      (await request(starter, 'GET', '/auth/access')).accessMode === 'full',
    );
    const warehouse = await request(
      starter,
      'POST',
      '/inventory/warehouses',
      { name: 'Gazipur Stripe QA', code: `STR-${suffix}` },
      201,
    );
    const item = await request(
      starter,
      'POST',
      '/inventory/items',
      {
        sku: `STR-${suffix}`,
        name: 'Cotton subscription QA',
        type: 'raw_material',
        unit: 'kg',
        reorderLevel: 100,
      },
      201,
    );
    await request(starter, 'POST', `/inventory/items/${item.id}/adjust`, {
      warehouseId: warehouse.id,
      quantityDelta: 200,
      reasonCode: 'opening',
    });
    const candidates = Array.from({ length: 10 }, (_, n) => ({
      email: `seat${n}-${suffix}@stripe-qa.example.test`,
      fullName: `Seat ${n}`,
      role: 'viewer',
    }));
    const inviteResults = await Promise.all(
      candidates.map(async (body) => {
        const response = await fetch(base + '/auth/invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${starter.token}` },
          body: JSON.stringify(body),
        });
        const payload: any = await response.json();
        return { ...body, status: response.status, user: payload.data };
      }),
    );
    pass(
      'Concurrent invitations cannot exceed trial seats',
      inviteResults.filter((r) => r.status === 201).length === 9 &&
        inviteResults.filter((r) => r.status === 409).length === 1,
    );
    const accepted: Array<{ tenant: Tenant; userId: string }> = [];
    for (const row of inviteResults.filter((r) => r.status === 201)) {
      const token = await emailToken(row.email);
      const login = await request(undefined, 'POST', '/auth/accept-invite', { token, password });
      accepted.push({
        tenant: { ...starter, token: login.accessToken, email: row.email },
        userId: login.user.id,
      });
    }
    pass(
      'Pending invitations and active users both occupy seats',
      (await request(starter, 'GET', '/auth/access')).seats.used === 10,
    );
    const viewer = accepted[1]!.tenant;
    await request(viewer, 'POST', '/reports/budget', { monthlyLimit: 1000, currency: 'BDT' }, 403);
    await request(
      viewer,
      'POST',
      '/reports/weekly-digest',
      { from: new Date(Date.now() - 86400_000).toISOString(), to: new Date().toISOString() },
      403,
    );
    await request(viewer, 'POST', '/uploads', {}, 403);
    pass('Viewer cannot update budget, generate AI report or upload', true);
    await request(starter, 'PATCH', `/auth/users/${accepted[0]!.userId}/role`, { role: 'manager' });
    const managerLogin = await request(undefined, 'POST', '/auth/login', {
      email: accepted[0]!.tenant.email,
      password,
    });
    const manager = { ...starter, token: managerLogin.accessToken };
    await request(manager, 'GET', '/billing/invoices', undefined, 403);
    pass('Manager cannot read or manage company billing', true);
    await request(manager, 'POST', '/billing/trial/restart', {}, 403);
    await request(viewer, 'POST', '/billing/trial/restart', {}, 403);
    pass('Only Owner can restart a company trial', true);
    await scope(starter, () =>
      Subscription.updateOne(
        {},
        {
          $set: {
            trialEndsAt: new Date(Date.now() - 1000),
            currentPeriodEnd: new Date(Date.now() - 1000),
          },
        },
      ).exec(),
    );
    pass(
      'Old JWT cannot keep expired trial writable',
      (await request(starter, 'GET', '/auth/access')).accessMode === 'read_only',
    );
    await request(starter, 'GET', '/inventory/items');
    await request(starter, 'GET', '/reports/artifacts');
    await request(
      starter,
      'POST',
      `/inventory/items/${item.id}/adjust`,
      { warehouseId: warehouse.id, quantityDelta: -1, reasonCode: 'production_consume' },
      403,
    );
    await request(starter, 'POST', '/ai/forecasts', { itemId: item.id, horizonDays: 30 }, 403);
    await request(
      starter,
      'POST',
      '/auth/invite',
      { email: `blocked-${suffix}@stripe-qa.example.test`, fullName: 'Blocked', role: 'viewer' },
      403,
    );
    pass('Expired trial retains read/export but blocks stock, AI and invites', true);
    await request(starter, 'POST', '/billing/trial/restart', { days: 365 }, 400);
    const restartKey = randomUUID();
    const restarted = await request(starter, 'POST', '/billing/trial/restart', {}, 200, restartKey);
    const replayRestart = await request(
      starter,
      'POST',
      '/billing/trial/restart',
      {},
      200,
      restartKey,
    );
    pass(
      'Restart grants fresh fourteen days and ten seats',
      restarted.tier === 'trial' &&
        restarted.status === 'trialing' &&
        restarted.seats === 10 &&
        Math.abs(new Date(restarted.trialEndsAt).getTime() - Date.now() - 14 * 86400_000) < 30_000,
    );
    pass(
      'Restart retry does not extend or count the trial twice',
      restarted.trialEndsAt === replayRestart.trialEndsAt &&
        (await subscription(starter))!.trialRestartCount === 1,
    );
    const trialAccess = await request(starter, 'GET', '/auth/access');
    pass(
      'Existing JWT immediately gets all business features after restart',
      trialAccess.accessMode === 'full' &&
        trialAccess.features.length ===
          catalogue.plans.find((p: any) => p.tier === 'enterprise').features.length,
    );
    const usage = await request(starter, 'GET', '/ai/usage');
    pass(
      'Trial AI exposes unlimited caps as null',
      usage.unlimited === true && Object.values(usage.cap).every((v) => v === null),
    );
    // Preserve the concurrency test but free seats before choosing five-seat Starter.
    for (const extra of accepted.slice(2))
      await request(starter, 'DELETE', `/auth/users/${extra.userId}`, undefined, 204);
    await request(
      starter,
      'POST',
      '/billing/checkout-session',
      {
        tier: 'starter',
        gateway: 'sslcommerz',
        successUrl: env.FRONTEND_BASE_URL + '/ok',
        cancelUrl: env.FRONTEND_BASE_URL + '/cancel',
      },
      400,
    );
    pass('SSLCommerz checkout is no longer accepted', true);
    let sigResponse = await fetch(base + webhookPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 'bad-signature' },
      body: '{}',
    });
    pass('Forged Stripe webhook is rejected', sigResponse.status === 401);
    const starterSub = await checkout(starter, 'starter');
    await request(starter, 'GET', '/ai/usage', undefined, 403);
    await request(starter, 'GET', '/reports/abc-analysis', undefined, 403);
    await request(starter, 'GET', '/inventory/items');
    pass('Starter allows core inventory but gates AI and advanced reports', true);
    const portal = await request(starter, 'POST', '/billing/portal-session', {
      returnUrl: env.FRONTEND_BASE_URL + '/billing',
    });
    pass(
      'Verified owner receives real Stripe customer portal',
      portal.redirectUrl.startsWith('https://billing.stripe.com/'),
    );
    const growth = await register('growth');
    await checkout(growth, 'growth');
    await request(growth, 'GET', '/ai/usage');
    await request(growth, 'GET', '/reports/abc-analysis');
    pass('Growth unlocks AI and advanced reports', true);
    const enterprise = await register('enterprise');
    await checkout(enterprise, 'enterprise');
    pass(
      'Enterprise grants 100 seats',
      (await request(enterprise, 'GET', '/auth/access')).seats.limit === 100,
    );
    const actual = webhooks.find(
      (w) =>
        w.event.type === 'checkout.session.completed' &&
        w.event.data.object.metadata?.tenantId === starter.id.toString(),
    );
    assert.ok(actual, 'Actual checkout webhook captured');
    const signature = api.webhooks.generateTestHeaderString({
      payload: actual.body.toString(),
      secret: env.STRIPE_WEBHOOK_SECRET,
    });
    const replay = await fetch(base + webhookPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
      body: actual.body,
    });
    const replayBody: any = await replay.json();
    pass(
      'Actual signed event replay is idempotent',
      replay.status === 200 && replayBody.data.duplicate === true,
    );
    pass(
      'One Stripe event produces one receipt',
      (await StripeEventReceipt.countDocuments({ _id: actual.event.id })) === 1,
    );
    await request(starter, 'POST', '/billing/subscription/cancel', { cancelImmediately: false });
    await request(starter, 'POST', '/billing/trial/restart', {}, 409);
    pass('Restart cannot replace an active paid Stripe subscription', true);
    pass(
      'Period-end cancellation keeps current paid access',
      (await request(starter, 'GET', '/auth/access')).accessMode === 'full' &&
        (await subscription(starter))!.cancelAtPeriodEnd,
    );
    await request(starter, 'POST', '/billing/subscription/change', { tier: 'growth' });
    await waitFor(
      'Paid upgrade changes plan after Stripe invoice confirmation',
      () => subscription(starter),
      (row) => row?.tier === 'growth' && row.status === 'active',
    );
    await request(growth, 'POST', '/billing/subscription/change', { tier: 'starter' });
    pass(
      'Downgrade schedules next cycle without removing paid Growth access',
      (await subscription(growth))!.tier === 'growth' &&
        (await subscription(growth))!.scheduledTier === 'starter',
    );
    for (let n = 0; n < 5; n++)
      await request(
        enterprise,
        'POST',
        '/auth/invite',
        {
          email: `enterprise-seat-${n}-${suffix}@stripe-qa.example.test`,
          fullName: `Enterprise seat ${n}`,
          role: 'viewer',
        },
        201,
      );
    await request(enterprise, 'POST', '/billing/subscription/change', { tier: 'starter' }, 409);
    pass('Downgrade cannot exceed target plan seat limit', true);
    await request(starter, 'POST', '/billing/subscription/cancel', { cancelImmediately: true });
    pass(
      'Immediate cancellation revokes paid writes for old JWT',
      (await request(starter, 'GET', '/auth/access')).accessMode === 'read_only',
    );
    await request(starter, 'GET', '/inventory/items');
    const stale = {
      ...actual.event,
      id: `evt_qa_delayed_${randomUUID().replaceAll('-', '')}`,
      type: 'customer.subscription.updated',
      data: { object: { id: starterSub.gatewaySubscriptionId } },
    };
    const staleBody = JSON.stringify(stale),
      staleSignature = api.webhooks.generateTestHeaderString({
        payload: staleBody,
        secret: env.STRIPE_WEBHOOK_SECRET,
      });
    const delayed = await fetch(base + webhookPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': staleSignature },
      body: staleBody,
    });
    pass(
      'Signed delayed event cannot restore cancelled access',
      delayed.ok && (await subscription(starter))!.status === 'cancelled',
    );
    const ctx = {
      tenantId: starter.id,
      userId: new Types.ObjectId(starter.ownerId),
      role: 'owner' as const,
      subscriptionTier: 'enterprise' as const,
      seats: 100,
      features: new Set<string>(),
      requestId: 'stale-worker-test',
    };
    await assert.rejects(
      scope(starter, () =>
        aiService.runForecastForItem({ ctx, itemId: new Types.ObjectId(item.id), horizonDays: 30 }),
      ),
      /read\/export only/,
    );
    await assert.rejects(
      scope(starter, () =>
        generateWeeklyReport({
          tenantId: starter.id,
          weekStart: new Date(Date.now() - 86400_000),
          weekEnd: new Date(),
        }),
      ),
      /read\/export only/,
    );
    pass('Queued forecast/report cannot bypass current cancellation using stale tier', true);
    const restartedCancelled = await request(starter, 'POST', '/billing/trial/restart', {});
    pass(
      'Cancelled paid subscription can start a fresh trial without erasing invoices',
      restartedCancelled.tier === 'trial' &&
        (await request(starter, 'GET', '/billing/invoices')).length > 0,
    );
    console.log(
      `STRIPE SUBSCRIPTION TEST COMPLETE: ${checks.length} checks; all three paid plans paid through Checkout`,
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(err instanceof Error ? err.stack : error);
    process.exitCode = 1;
  } finally {
    // Test subscriptions only; preserve evidence and cancel recurring test billing.
    for (const tenant of tenants) {
      try {
        const sub = await subscription(tenant);
        if (sub?.gatewaySubscriptionId?.startsWith('sub_')) {
          const remote = await api.subscriptions.retrieve(sub.gatewaySubscriptionId);
          assert.equal(remote.livemode, false);
          if (remote.status !== 'canceled') {
            if (remote.schedule)
              await api.subscriptionSchedules.release(
                typeof remote.schedule === 'string' ? remote.schedule : remote.schedule.id,
              );
            await api.subscriptions.cancel(remote.id);
          }
        }
      } catch {}
    }
    await writeFile(
      'artifacts/stripe-subscription-test-results.json',
      JSON.stringify(
        {
          at: new Date().toISOString(),
          passed: !error,
          error,
          checks,
          plans,
          actualWebhookCount: webhooks.length,
          tenants: tenants.map((t) => ({ id: t.id.toString(), label: t.label })),
        },
        null,
        2,
      ),
    );
    listener?.kill();
    await browser?.close();
    await worker?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => smtp.close(resolve));
    await drainWebhooks();
    await closeQueues();
    await disconnectRedis();
    await disconnectDatabase();
  }
}
void main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
