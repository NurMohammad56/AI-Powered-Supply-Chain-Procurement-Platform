import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';

export type InvoiceStatus = 'paid' | 'open' | 'failed' | 'refunded' | 'void';
export const INVOICE_STATUSES: readonly InvoiceStatus[] = [
  'paid',
  'open',
  'failed',
  'refunded',
  'void',
] as const;

export type InvoiceCurrency = 'BDT' | 'USD';

/**
 * Billing invoice (FR-BIL-09). Monetary values are stored as integers
 * in the smallest currency unit (paisa for BDT, cents for USD) to avoid
 * floating-point rounding (SRS §2.5).
 */
export interface InvoiceDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  subscriptionId: Types.ObjectId;
  number: string;
  amountSubtotal: number;
  amountTax: number;
  amountTotal: number;
  currency: InvoiceCurrency;
  status: InvoiceStatus;
  pdfUrl: string | null;
  issuedAt: Date;
  paidAt: Date | null;
  dueAt: Date | null;
  gateway: 'stripe' | 'sslcommerz';
  gatewayInvoiceId: string | null;
  gatewayPaymentIntentId: string | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type InvoiceHydrated = HydratedDocument<InvoiceDoc>;

const invoiceSchema = new Schema<InvoiceDoc>(
  {
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', required: true },
    number: { type: String, required: true, trim: true, maxlength: 32 },
    amountSubtotal: { type: Number, required: true, min: 0 },
    amountTax: { type: Number, default: 0, min: 0 },
    amountTotal: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ['BDT', 'USD'], required: true },
    status: { type: String, enum: INVOICE_STATUSES, default: 'open', index: true },
    pdfUrl: { type: String, default: null, trim: true, maxlength: 2048 },
    issuedAt: { type: Date, required: true, default: () => new Date() },
    paidAt: { type: Date, default: null },
    dueAt: { type: Date, default: null },
    gateway: { type: String, enum: ['stripe', 'sslcommerz'], required: true },
    gatewayInvoiceId: { type: String, default: null, trim: true, maxlength: 128 },
    gatewayPaymentIntentId: { type: String, default: null, trim: true, maxlength: 128 },
    failureReason: { type: String, default: null, trim: true, maxlength: 1000 },
  },
  { timestamps: true },
);

invoiceSchema.index({ tenantId: 1, number: 1 }, { unique: true });
invoiceSchema.index({ tenantId: 1, issuedAt: -1 });
invoiceSchema.index({ tenantId: 1, status: 1, dueAt: 1 });
invoiceSchema.index(
  { gatewayInvoiceId: 1 },
  { unique: true, partialFilterExpression: { gatewayInvoiceId: { $type: 'string' } } },
);

invoiceSchema.plugin(tenancyPlugin);
invoiceSchema.plugin(auditPlugin);

export const Invoice = model<InvoiceDoc>('Invoice', invoiceSchema);
