import { env } from '../../config/env.js';

export interface SslCommerzInitiateInput {
  totalAmount: number;
  currency: string;
  tranId: string;
  productCategory: string;
  successUrl: string;
  failUrl: string;
  cancelUrl: string;
  ipnUrl?: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerAddress: string;
  customerCity: string;
  customerCountry: string;
  shippingMethod?: string;
  numOfItem?: number;
  valueA?: string | null;
  valueB?: string | null;
  valueC?: string | null;
  valueD?: string | null;
}

export interface SslCommerzInitiateResult {
  gatewayPageUrl: string;
  sessionKey: string | null;
  raw: Record<string, unknown>;
}

export interface SslCommerzValidationResult {
  status: string | null;
  amount: string | null;
  currency: string | null;
  tranId: string | null;
  sessionKey: string | null;
  valId: string | null;
  riskLevel: number | null;
  riskTitle: string | null;
  raw: Record<string, unknown>;
}

function gatewayBaseUrl(): string {
  return env.SSLCOMMERZ_IS_LIVE ? 'https://securepay.sslcommerz.com' : 'https://sandbox.sslcommerz.com';
}

function ensureCredentials(): void {
  if (!env.SSLCOMMERZ_STORE_ID || !env.SSLCOMMERZ_STORE_PASSWORD) {
    throw new Error('SSLCommerz credentials are missing: set SSLCOMMERZ_STORE_ID and SSLCOMMERZ_STORE_PASSWORD');
  }
}

function encodeForm(data: Record<string, string | number | boolean | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  return params.toString();
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function initiateSslCommerzTransaction(
  input: SslCommerzInitiateInput,
): Promise<SslCommerzInitiateResult> {
  ensureCredentials();
  const res = await fetch(`${gatewayBaseUrl()}/gwprocess/v4/api.php`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: encodeForm({
      store_id: env.SSLCOMMERZ_STORE_ID,
      store_passwd: env.SSLCOMMERZ_STORE_PASSWORD,
      total_amount: input.totalAmount.toFixed(2),
      currency: input.currency,
      tran_id: input.tranId,
      product_category: input.productCategory,
      success_url: input.successUrl,
      fail_url: input.failUrl,
      cancel_url: input.cancelUrl,
      ipn_url: input.ipnUrl,
      cus_name: input.customerName,
      cus_email: input.customerEmail,
      cus_add1: input.customerAddress,
      cus_city: input.customerCity,
      cus_country: input.customerCountry,
      cus_phone: input.customerPhone,
      ship_name: input.customerName,
      ship_add1: input.customerAddress,
      ship_city: input.customerCity,
      ship_country: input.customerCountry,
      shipping_method: input.shippingMethod ?? 'NO',
      num_of_item: input.numOfItem ?? 1,
      product_profile: 'general',
      value_a: input.valueA,
      value_b: input.valueB,
      value_c: input.valueC,
      value_d: input.valueD,
      format: 'json',
    }),
  });

  const raw = await readJsonResponse(res);
  const gatewayPageUrl =
    stringOrNull(raw.GatewayPageURL) ??
    stringOrNull(raw.gatewayPageURL) ??
    stringOrNull(raw.GatewaypageURL) ??
    '';
  const sessionKey = stringOrNull(raw.sessionkey) ?? stringOrNull(raw.sessionKey);

  if (!res.ok || !gatewayPageUrl) {
    throw new Error(`SSLCommerz initiate transaction failed: ${JSON.stringify(raw)}`);
  }

  return { gatewayPageUrl, sessionKey, raw };
}

export async function validateSslCommerzTransaction(input: {
  sessionKey?: string | null;
  tranId?: string | null;
  valId?: string | null;
}): Promise<SslCommerzValidationResult> {
  ensureCredentials();
  const params = new URLSearchParams({
    store_id: env.SSLCOMMERZ_STORE_ID,
    store_passwd: env.SSLCOMMERZ_STORE_PASSWORD,
    format: 'json',
  });
  if (input.valId) {
    params.set('val_id', input.valId);
  } else if (input.sessionKey) {
    params.set('sessionkey', input.sessionKey);
  } else if (input.tranId) {
    params.set('tran_id', input.tranId);
  }

  const endpoint = input.valId
    ? '/validator/api/validationserverAPI.php'
    : '/validator/api/merchantTransIDvalidationAPI.php';
  const res = await fetch(
    `${gatewayBaseUrl()}${endpoint}?${params.toString()}`,
    { method: 'GET' },
  );
  const raw = await readJsonResponse(res);
  return {
    status: stringOrNull(raw.status),
    amount: stringOrNull(raw.amount),
    currency: stringOrNull(raw.currency),
    tranId: stringOrNull(raw.tran_id) ?? stringOrNull(raw.tranId),
    sessionKey: stringOrNull(raw.sessionkey) ?? stringOrNull(raw.sessionKey),
    valId: stringOrNull(raw.val_id) ?? stringOrNull(raw.valId),
    riskLevel: numberOrNull(raw.risk_level) ?? numberOrNull(raw.riskLevel),
    riskTitle: stringOrNull(raw.risk_title) ?? stringOrNull(raw.riskTitle),
    raw,
  };
}
