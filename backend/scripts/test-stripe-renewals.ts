import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
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
import { connectRedis, disconnectRedis } from '../src/config/redis.js';
import { env } from '../src/config/env.js';
import { closeQueues } from '../src/shared/queue/queues.js';
import { tenantStorage } from '../src/shared/db/tenancyPlugin.js';
import { stripeClient, stripePrice } from '../src/modules/billing/stripe.client.js';
import { Subscription } from '../src/modules/billing/models/subscription.model.js';
import { CheckoutOrder } from '../src/modules/billing/models/checkoutOrder.model.js';
import { User } from '../src/modules/auth/models/user.model.js';
import { Invoice } from '../src/modules/billing/models/invoice.model.js';

const api = stripeClient(),
  checks: Array<{ name: string; pass: boolean }> = [];
const server = createServer(createApp());
let base = '',
  token = '',
  tenantId: Types.ObjectId,
  clockId = '',
  remoteId = '';
let listener: ReturnType<typeof spawn> | undefined;
const scope = <T>(fn: () => Promise<T>) => tenantStorage.run({ tenantId }, fn);
function pass(name: string, condition: unknown) {
  assert.ok(condition, name);
  checks.push({ name, pass: true });
  console.log(`PASS ${name}`);
}
async function wait<T>(
  name: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeout = 120_000,
): Promise<T> {
  const end = Date.now() + timeout;
  do {
    const row = await read();
    if (ready(row)) {
      pass(name, true);
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  } while (Date.now() < end);
  throw new Error(`Timeout: ${name}`);
}
async function request(method: string, path: string, body?: any, status = 200, auth = token) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
      ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const data: any = response.status === 204 ? {} : await response.json();
  assert.equal(
    response.status,
    status,
    `${method} ${path}: ${response.status} ${data.error?.message ?? ''}`,
  );
  return data.data;
}
const localSub = () => scope(() => Subscription.findOne().lean().exec());
async function advance(unix: number) {
  await api.testHelpers.testClocks.advance(clockId, { frozen_time: unix });
  await wait(
    'Stripe test clock completed billing simulation',
    () => api.testHelpers.testClocks.retrieve(clockId),
    (clock) => clock.status === 'ready',
    180_000,
  );
}
async function main() {
  let error: string | undefined;
  try {
    assert.match(env.STRIPE_SECRET_KEY, /^sk_test_/);
    assert.match(env.QUEUE_PREFIX, /^stripe-renewal-qa-/);
    await connectDatabase();
    await connectRedis();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
    let ready = false;
    listener = spawn(
      'stripe',
      [
        'listen',
        '--skip-update',
        '--forward-to',
        base + '/webhooks/stripe',
        '--events',
        'customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed',
      ],
      { env: { ...process.env, STRIPE_API_KEY: env.STRIPE_SECRET_KEY }, windowsHide: true },
    );
    for (const stream of [listener.stdout, listener.stderr])
      stream?.on('data', (data: Buffer) => {
        if (/whsec_/.test(data.toString())) ready = true;
      });
    await wait('Real Stripe renewal webhook listener ready', async () => ready, Boolean, 30_000);
    const email = `renewal-${Date.now()}@stripe-qa.example.test`,
      password = 'StripeRenewal!2026';
    const registration = await request(
      'POST',
      '/auth/register',
      {
        factory: { name: `Stripe Renewal QA ${Date.now()}`, businessType: 'rmg' },
        owner: { fullName: 'Renewal QA Owner', email, password },
      },
      201,
      '',
    );
    tenantId = new Types.ObjectId(registration.factory.id);
    // Onboarding verification is tested through SMTP in the full Checkout suite.
    await scope(() =>
      User.updateOne(
        { _id: registration.owner.id },
        { $set: { emailVerifiedAt: new Date() } },
      ).exec(),
    );
    token = (await request('POST', '/auth/login', { email, password }, 200, '')).accessToken;
    const clock = await api.testHelpers.testClocks.create({
      frozen_time: Math.floor(Date.now() / 1000),
      name: `Supply Chain Renewal QA ${tenantId}`,
    });
    clockId = clock.id;
    const customer = await api.customers.create({
      email,
      test_clock: clockId,
      metadata: { tenantId: tenantId.toString(), application: 'scp-platform' },
    });
    const method = await api.paymentMethods.attach('pm_card_visa', { customer: customer.id });
    await api.customers.update(customer.id, {
      invoice_settings: { default_payment_method: method.id },
    });
    await scope(() =>
      Subscription.updateOne(
        {},
        { $set: { gateway: 'stripe', gatewayCustomerId: customer.id } },
      ).exec(),
    );
    const order = await scope(() =>
      CheckoutOrder.create({ tier: 'growth', amount: 14900, currency: 'usd' }),
    );
    const price = await stripePrice('growth');
    const created = await api.subscriptions.create({
      customer: customer.id,
      items: [{ price: price.id }],
      payment_behavior: 'error_if_incomplete',
      metadata: {
        tenantId: tenantId.toString(),
        orderId: order._id.toString(),
        tier: 'growth',
        application: 'scp-platform',
      },
    });
    remoteId = created.id;
    pass('Test clock subscription is not live', !created.livemode);
    await wait(
      'Initial actual invoice activates Growth via webhook',
      localSub,
      (row) => row?.tier === 'growth' && row.status === 'active',
    );
    let remote = await api.subscriptions.retrieve(remoteId);
    const firstEnd = remote.items.data[0]!.current_period_end;
    await advance(firstEnd + 7200);
    await advance(firstEnd + 10800);
    await wait(
      'Real monthly renewal creates a second paid invoice',
      () => scope(() => Invoice.countDocuments({ status: 'paid' }).exec()),
      (count) => count >= 2,
    );
    pass(
      'Renewal extends local paid-through period from Stripe',
      (await localSub())!.currentPeriodEnd.getTime() > firstEnd * 1000,
    );
    const failureMethod = await api.paymentMethods.attach('pm_card_chargeCustomerFail', {
      customer: customer.id,
    });
    await api.customers.update(customer.id, {
      invoice_settings: { default_payment_method: failureMethod.id },
    });
    remote = await api.subscriptions.retrieve(remoteId);
    const secondEnd = remote.items.data[0]!.current_period_end;
    await advance(secondEnd + 7200);
    await advance(secondEnd + 10800);
    await wait(
      'Failed real renewal marks subscription past_due',
      localSub,
      (row) => row?.status === 'past_due',
    );
    pass(
      'Failed renewal makes existing JWT read-only',
      (await request('GET', '/auth/access')).accessMode === 'read_only',
    );
    await request('GET', '/inventory/items');
    await request(
      'POST',
      '/inventory/items',
      { sku: 'DENIED', name: 'Denied', type: 'raw_material', unit: 'kg' },
      403,
    );
    pass('Read survives while writes are blocked after payment failure', true);
    const successMethod = await api.paymentMethods.attach('pm_card_visa', {
      customer: customer.id,
    });
    await api.customers.update(customer.id, {
      invoice_settings: { default_payment_method: successMethod.id },
    });
    remote = await api.subscriptions.retrieve(remoteId);
    await api.invoices.pay(
      typeof remote.latest_invoice === 'string' ? remote.latest_invoice : remote.latest_invoice!.id,
      { payment_method: successMethod.id },
    );
    await wait(
      'Real recovery payment restores active access',
      localSub,
      (row) => row?.status === 'active',
    );
    pass(
      'Same JWT sees recovered full access',
      (await request('GET', '/auth/access')).accessMode === 'full',
    );
    await request('POST', '/billing/subscription/change', { tier: 'starter' });
    pass(
      'Downgrade remains pending until the next paid cycle',
      (await localSub())!.scheduledTier === 'starter' && (await localSub())!.tier === 'growth',
    );
    remote = await api.subscriptions.retrieve(remoteId);
    const nextEnd = remote.items.data[0]!.current_period_end;
    await advance(nextEnd + 7200);
    await advance(nextEnd + 10800);
    await wait(
      'Actual scheduled downgrade activates Starter at renewal',
      localSub,
      (row) => row?.tier === 'starter' && row.status === 'active',
    );
    await request('GET', '/ai/usage', undefined, 403);
    pass('Downgraded plan loses AI access even with old JWT', true);
    await request('POST', '/billing/subscription/cancel', { cancelImmediately: false });
    remote = await api.subscriptions.retrieve(remoteId);
    const cancelEnd = remote.items.data[0]!.current_period_end;
    await advance(cancelEnd + 120);
    await wait(
      'Period-end cancellation becomes cancelled through Stripe',
      localSub,
      (row) => row?.status === 'cancelled',
    );
    pass(
      'Period-end cancellation retains read-only access',
      (await request('GET', '/auth/access')).accessMode === 'read_only',
    );
    console.log(`STRIPE RENEWAL TEST COMPLETE: ${checks.length} checks`);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(err instanceof Error ? err.stack : error);
    process.exitCode = 1;
  } finally {
    if (remoteId)
      try {
        const remote = await api.subscriptions.retrieve(remoteId);
        if (!remote.livemode && remote.status !== 'canceled') {
          if (remote.schedule)
            await api.subscriptionSchedules.release(
              typeof remote.schedule === 'string' ? remote.schedule : remote.schedule.id,
            );
          await api.subscriptions.cancel(remoteId);
        }
      } catch {}
    await writeFile(
      'artifacts/stripe-renewal-test-results.json',
      JSON.stringify(
        {
          at: new Date().toISOString(),
          passed: !error,
          error,
          checks,
          tenantId: tenantId!?.toString(),
          clockId,
          subscriptionId: remoteId,
        },
        null,
        2,
      ),
    );
    listener?.kill();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
