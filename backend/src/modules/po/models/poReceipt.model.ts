import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';

export interface PoReceiptLine {
  poLineId: Types.ObjectId;
  itemId: Types.ObjectId;
  quantity: number;
  unitCost: number | null;
  qualityNotes: string | null;
}

export type PoReceiptResultingState = 'partially_received' | 'fully_received';

/**
 * Goods receipt against a PO (SDD §4.2.4 / FR-PO-09..10). One PO may
 * have many `poReceipts` until the cumulative received quantity equals
 * the ordered quantity for every line.
 */
export interface PoReceiptDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  poId: Types.ObjectId;
  poNumber: string;
  receivedAt: Date;
  receivedBy: Types.ObjectId;
  warehouseId: Types.ObjectId;
  lines: PoReceiptLine[];
  grnDocumentUrl: string | null;
  resultingState: PoReceiptResultingState;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PoReceiptHydrated = HydratedDocument<PoReceiptDoc>;

const poReceiptLineSchema = new Schema<PoReceiptLine>(
  {
    poLineId: { type: Schema.Types.ObjectId, required: true },
    itemId: { type: Schema.Types.ObjectId, ref: 'Item', required: true },
    quantity: { type: Number, required: true, min: 0 },
    unitCost: { type: Number, default: null, min: 0 },
    qualityNotes: { type: String, default: null, trim: true, maxlength: 500 },
  },
  { _id: false },
);

const poReceiptSchema = new Schema<PoReceiptDoc>(
  {
    poId: { type: Schema.Types.ObjectId, ref: 'PurchaseOrder', required: true },
    poNumber: { type: String, required: true, trim: true, maxlength: 32 },
    receivedAt: { type: Date, required: true, default: () => new Date() },
    receivedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    lines: { type: [poReceiptLineSchema], required: true },
    grnDocumentUrl: { type: String, default: null, trim: true, maxlength: 2048 },
    resultingState: {
      type: String,
      enum: ['partially_received', 'fully_received'],
      required: true,
    },
    notes: { type: String, default: null, trim: true, maxlength: 2000 },
  },
  { timestamps: true },
);

poReceiptSchema.index({ tenantId: 1, poId: 1, receivedAt: -1 });
poReceiptSchema.index({ tenantId: 1, warehouseId: 1, receivedAt: -1 });
poReceiptSchema.index({ tenantId: 1, receivedAt: -1 });

poReceiptSchema.plugin(tenancyPlugin);
poReceiptSchema.plugin(auditPlugin);

export const PoReceipt = model<PoReceiptDoc>('PoReceipt', poReceiptSchema);
