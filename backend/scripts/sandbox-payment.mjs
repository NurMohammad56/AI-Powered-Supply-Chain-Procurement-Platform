import { readFile, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import mongoose from 'mongoose';
if (process.env.SSLCOMMERZ_IS_LIVE === 'true')
  throw new Error('This test only permits SSLCommerz sandbox.');
const demo = JSON.parse(await readFile('artifacts/garments-demo-manifest.json', 'utf8'));
demo.baseUrl = process.env.REGRESSION_BASE_URL || demo.baseUrl;
const login = await fetch(demo.baseUrl + '/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: demo.users.owner, password: demo.password }),
});
const token = (await login.json()).data.accessToken;
const checkout = await fetch(demo.baseUrl + '/billing/checkout-session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    tier: 'growth',
    gateway: 'sslcommerz',
    successUrl: 'http://localhost:3000/sandbox-success',
    cancelUrl: 'http://localhost:3000/sandbox-cancel',
  }),
});
const body = await checkout.json();
const url = body.data?.redirectUrl;
if (!url || new URL(url).hostname !== 'sandbox.sslcommerz.com')
  throw new Error('Expected an actual SSLCommerz sandbox checkout');
const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
  headless: true,
});
const page = await browser.newPage();
let callbackBody = '';
page.on('request', (request) => {
  if (request.url().startsWith('http://localhost:3000/sandbox-success'))
    callbackBody = request.postData() ?? '';
});
try {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  await page.type('#ccnum', '4111111111111111');
  await page.type('#expiry', '12/26');
  await page.type('input[name="cvc"]', '111');
  await page.type('input[name="name"]', 'Garments Sandbox Test');
  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
    page.click('button'),
  ]);
  await page.type('input[name="pan"]', '111111');
  await Promise.allSettled([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
    page.click('input[type="submit"]'),
  ]);
  if (!callbackBody)
    callbackBody = await page.evaluate(() => {
      const form = document.querySelector('form[action="http://localhost:3000/sandbox-success"]');
      return form
        ? new URLSearchParams(
            Array.from(new FormData(form)).map(([key, value]) => [key, String(value)]),
          ).toString()
        : '';
    });
  if (!callbackBody) throw new Error('No successful sandbox callback captured');
  const payload = new URLSearchParams(callbackBody);
  const results = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(demo.baseUrl + '/webhooks/sslcommerz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: callbackBody,
    });
    results.push({
      name: attempt ? 'Successful IPN replay' : 'Real sandbox payment validation',
      status: response.status,
      response: await response.json(),
    });
  }
  await mongoose.connect(process.env.MONGO_URI);
  const filter = {
    tenantId: new mongoose.Types.ObjectId(demo.tenantId),
    gatewayInvoiceId: payload.get('tran_id'),
  };
  const invoice = await mongoose.connection.db.collection('invoices').findOne(filter);
  const attempts = await mongoose.connection.db
    .collection('paymentattempts')
    .find({
      tenantId: new mongoose.Types.ObjectId(demo.tenantId),
      gatewayPaymentIntentId: payload.get('tran_id'),
    })
    .toArray();
  const riskLevel = Number(attempts[0]?.gatewayResponseSummary?.risk_level ?? 0);
  const safeAttempt = await mongoose.connection.db
    .collection('paymentattempts')
    .findOne({
      tenantId: new mongoose.Types.ObjectId(demo.tenantId),
      status: 'succeeded',
      'gatewayResponseSummary.risk_level': { $in: ['0', 0] },
    });
  const safeInvoice = safeAttempt?.invoiceId
    ? await mongoose.connection.db.collection('invoices').findOne({ _id: safeAttempt.invoiceId })
    : null;
  const correctDecision =
    riskLevel === 0
      ? invoice?.status === 'paid' && attempts[0]?.status === 'succeeded'
      : riskLevel === 1 && invoice?.status === 'failed' && attempts[0]?.status === 'failed';
  const summary = {
    sandbox: true,
    transactionId: payload.get('tran_id'),
    riskLevel,
    invoiceStatus: invoice?.status,
    amountMinor: invoice?.amountTotal,
    currency: invoice?.currency,
    paymentAttemptCount: attempts.length,
    paymentStatus: attempts[0]?.status,
    verifiedSafePayment: safeInvoice
      ? {
          transactionId: safeInvoice.gatewayInvoiceId,
          status: safeInvoice.status,
          amountMinor: safeInvoice.amountTotal,
          currency: safeInvoice.currency,
        }
      : null,
    results,
    passed:
      correctDecision &&
      invoice?.amountTotal === 14900 &&
      attempts.length === 1 &&
      results.every((r) => r.status === 200) &&
      safeInvoice?.status === 'paid',
  };
  await writeFile('artifacts/sandbox-payment-results.json', JSON.stringify(summary, null, 2));
  console.log(summary);
  await mongoose.disconnect();
  if (!summary.passed) process.exitCode = 1;
} finally {
  await browser.close();
}
