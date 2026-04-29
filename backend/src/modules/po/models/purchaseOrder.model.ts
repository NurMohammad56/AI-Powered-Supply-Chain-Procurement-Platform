import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';

export type PurchaseOrderState =
  | 'draft'
  | 'pending_approval'
  | 'approved'
  | 'sent'
  | 'partially_received'
  | 'fully_received'
  | 'closed'
  | 'cancelled'
  | 'rejected';

export const PURCHASE_ORDER_STATES: readonly PurchaseOrderState[] = [
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'partially_received',
  'fully_received',
  'closed',
  'cancelled',
  'rejected',
] as const;

/**
 * Allowed forward transitions of the PO state machine (SDD §3.5.1).
 * Reverse transitions are prohibited; the only side branches are the
 * Cancelled (any state pre-Closed, Owner only) and Rejected (from
 * Pending Approval) terminal exits.
 */
export const PURCHASE_ORDER_TRANSITIONS: Readonly<Record<PurchaseOrderState, readonly PurchaseOrderState[]>> = {
  draft: ['pending_approval', 'cancelled'],
  pending_approval: ['approved', 'rejected', 'cancelled'],
  approved: ['sent', 'cancelled'],
  sent: ['partially_received', 'fully_received', 'cancelled'],
  partially_received: ['partially_received', 'fully_received', 'cancelled'],
  fully_received: ['closed'],
  closed: [],
  cancelled: [],
  rejected: ['draft'],
} as const;

export interface PoLineItemSnapshot {
  sku: string;
  name: string;
  unit: string;
}

export interface PoLine {
  itemId: Types.ObjectId;
  itemSnapshot: PoLineItemSnapshot;
  quantityOrdered: number;
  quantityReceived: number;
  unitPrice: number;
  lineTotal: number;
  expectedDeliveryAt: Date | null;
  remarks: string | null;
}

export interface PoSupplierSnapshot {
  legalName: string;
  address: string | null;
  primaryContactEmail: string | null;
}

export interface PoApproval {
  submittedAt: Date | null;
  submittedBy: Types.ObjectId | null;
  decidedAt: Date | null;
  decidedBy: Types.ObjectId | null;
  decision: 'approved' | 'rejected' | null;
  rejectReason: string | null;
  thresholdRule: string | null;
}

export interface PoDispatch {
  sentAt: Date;
  sentTo: string;
  emailDeliveryId: Types.ObjectId | null;
}

export interface PoCancellation {
  cancelledAt: Date;
  cancelledBy: Types.ObjectId;
  reason: string;
}

export interface PoRevision {
  at: Date;
  by: Types.ObjectId;
  diff: unknown;
}

export interface PoTotals {
  subtotal: number;
  tax: number;
  total: number;
}

export interface PurchaseOrderDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  number: string;
  state: PurchaseOrderState;
  supplierId: Types.ObjectId;
  supplierSnapshot: PoSupplierSnapshot;
  warehouseId: Types.ObjectId;
  currency: 'BDT' | 'USD';
  paymentTermsDays: number;
  expectedDeliveryAt: Date;
  lines: PoLine[];
  totals: PoTotals;
  pdfUrl: string | null;
  pdfGeneratedAt: Date | null;
  approval: PoApproval | null;
  dispatch: PoDispatch | null;
  cancellation: PoCancellation | null;
  revisions: PoRevision[];
  createdBy: Types.ObjectId;
  approvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PurchaseOrderHydrated = HydratedDocument<PurchaseOrderDoc>;

const itemSnapshotSchema = new Schema<PoLineItemSnapshot>(
  {
    sku: { type: String, required: true, trim: true, maxlength: 64 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    unit: { type: String, required: true, trim: true, maxlength: 16 },
  },
  { _id: false },
);

const poLineSchema = new Schema<PoLine>(
  {
    itemId: { type: Schema.Types.ObjectId, ref: 'Item', required: true },
    itemSnapshot: { type: itemSnapshotSchema, required: true },
    quantityOrdered: { type: Number, required: true, min: 0 },
    quantityReceived: { type: Number, default: 0, min: 0 },
    unitPrice: { type: Number, required: true, min: 0 },
    lineTotal: { type: Number, required: true, min: 0 },
    expectedDeliveryAt: { type: Date, default: null },
    remarks: { type: String, default: null, trim: true, maxlength: 500 },
  },
  { _id: true },
);

const supplierSnapshotSchema = new Schema<PoSupplierSnapshot>(
  {
    legalName: { type: String, required: true, trim: true, maxlength: 200 },
    address: { type: String, default: null, trim: true, maxlength: 500 },
    primaryContactEmail: { type: String, default: null, lowercase: true, trim: true, maxlength: 254 },
  },
  { _id: false },
);

const approvalSchema = new Schema<PoApproval>(
  {
    submittedAt: { type: Date, default: null },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    decision: { type: String, enum: ['approved', 'rejected', null], default: null },
    rejectReason: { type: String, default: null, trim: true, maxlength: 1000 },
    thresholdRule: { type: String, default: null, trim: true, maxlength: 80 },
  },
  { _id: false },
);

const dispatchSchema = new Schema<PoDispatch>(
  {
    sentAt: { type: Date, required: true },
    sentTo: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    emailDeliveryId: { type: Schema.Types.ObjectId, ref: 'EmailDelivery', default: null },
  },
  { _id: false },
);

const cancellationSchema = new Schema<PoCancellation>(
  {
    cancelledAt: { type: Date, required: true },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
  },
  { _id: false },
);

const revisionSchema = new Schema<PoRevision>(
  {
    at: { type: Date, required: true, default: () => new Date() },
    by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    diff: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false },
);

const totalsSchema = new Schema<PoTotals>(
  {
    subtotal: { type: Number, required: true, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    total: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const purchaseOrderSchema = new Schema<PurchaseOrderDoc>(
  {
    number: { type: String, required: true, trim: true, maxlength: 32 },
    state: {
      type: String,
      enum: PURCHASE_ORDER_STATES,
      default: 'draft',
      index: true,
    },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    supplierSnapshot: { type: supplierSnapshotSchema, required: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    currency: { type: String, enum: ['BDT', 'USD'], default: 'BDT' },
    paymentTermsDays: { type: Number, default: 30, min: 0, max: 365 },
    expectedDeliveryAt: { type: Date, required: true },
    lines: {
      type: [poLineSchema],
      required: true,
      validate: {
        validator: (v: PoLine[]) => v.length > 0 && v.length <= 200,
        message: 'PO must have between 1 and 200 line items',
      },
    },
    totals: { type: totalsSchema, required: true },
    pdfUrl: { type: String, default: null, trim: true, maxlength: 2048 },
    pdfGeneratedAt: { type: Date, default: null },
    approval: { type: approvalSchema, default: null },
    dispatch: { type: dispatchSchema, default: null },
    cancellation: { type: cancellationSchema, default: null },
    revisions: { type: [revisionSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    approvedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

purchaseOrderSchema.index({ tenantId: 1, number: 1 }, { unique: true });
purchaseOrderSchema.index({ tenantId: 1, state: 1, expectedDeliveryAt: 1 });
purchaseOrderSchema.index({ tenantId: 1, supplierId: 1, createdAt: -1 });
purchaseOrderSchema.index({ tenantId: 1, createdAt: -1 });
purchaseOrderSchema.index({ tenantId: 1, 'totals.total': -1 });
// Targeted index for delivery-reminder cron (FR-PO-13).
purchaseOrderSchema.index(
  { tenantId: 1, state: 1, expectedDeliveryAt: 1 },
  {
    name: 'po_delivery_reminder',
    partialFilterExpression: { state: { $in: ['sent', 'partially_received'] } },
  },
);

purchaseOrderSchema.plugin(tenancyPlugin);
purchaseOrderSchema.plugin(auditPlugin);

export const PurchaseOrder = model<PurchaseOrderDoc>('PurchaseOrder', purchaseOrderSchema);
