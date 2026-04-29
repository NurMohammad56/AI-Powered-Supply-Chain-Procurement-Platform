import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';

export type StockMovementType =
  | 'in'
  | 'out'
  | 'transfer_in'
  | 'transfer_out'
  | 'adjustment'
  | 'opening';

export const STOCK_MOVEMENT_TYPES: readonly StockMovementType[] = [
  'in',
  'out',
  'transfer_in',
  'transfer_out',
  'adjustment',
  'opening',
] as const;

export type StockMovementReferenceKind =
  | 'po_receipt'
  | 'po_receipt_partial'
  | 'transfer'
  | 'adjustment'
  | 'opening'
  | 'manual';

export interface StockMovementReference {
  kind: StockMovementReferenceKind;
  id: Types.ObjectId | null;
}

/**
 * Append-only ledger of stock movements (SDD §4.2.2 / FR-INV-06..09).
 *
 * - Quantity is SIGNED: positive for in / transfer_in / positive adjustment;
 *   negative for out / transfer_out / negative adjustment.
 * - `unitCost` is populated on PO receipts and feeds the moving-average
 *   cost computation on `items.movingAverageCost`.
 * - This collection is NEVER updated or deleted in production paths.
 *   The weekly `inventory.balance_audit` job reconstructs `stockBalances`
 *   from this ledger and reconciles drift.
 */
export interface StockMovementDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  itemId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  type: StockMovementType;
  quantity: number;
  unitCost: number | null;
  reasonCode: string;
  reference: StockMovementReference;
  attachmentUrl: string | null;
  performedBy: Types.ObjectId;
  performedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type StockMovementHydrated = HydratedDocument<StockMovementDoc>;

const referenceSchema = new Schema<StockMovementReference>(
  {
    kind: {
      type: String,
      enum: ['po_receipt', 'po_receipt_partial', 'transfer', 'adjustment', 'opening', 'manual'],
      required: true,
    },
    id: { type: Schema.Types.ObjectId, default: null },
  },
  { _id: false },
);

const stockMovementSchema = new Schema<StockMovementDoc>(
  {
    itemId: { type: Schema.Types.ObjectId, ref: 'Item', required: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    type: { type: String, enum: STOCK_MOVEMENT_TYPES, required: true },
    quantity: { type: Number, required: true },
    unitCost: { type: Number, default: null, min: 0 },
    reasonCode: { type: String, required: true, trim: true, maxlength: 64 },
    reference: { type: referenceSchema, required: true },
    attachmentUrl: { type: String, default: null, trim: true, maxlength: 2048 },
    performedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    performedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true },
);

// Per-item history (FR-INV-10)
stockMovementSchema.index({ tenantId: 1, itemId: 1, performedAt: -1 });
// Per-warehouse history
stockMovementSchema.index({ tenantId: 1, warehouseId: 1, performedAt: -1 });
// Reverse lookup from a PO/transfer/adjustment
stockMovementSchema.index({ tenantId: 1, 'reference.kind': 1, 'reference.id': 1 });
// Generic time-window query (audits, reports)
stockMovementSchema.index({ tenantId: 1, performedAt: -1 });

stockMovementSchema.plugin(tenancyPlugin);
stockMovementSchema.plugin(auditPlugin);

export const StockMovement = model<StockMovementDoc>('StockMovement', stockMovementSchema);
