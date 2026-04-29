import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';

/**
 * Quarterly snapshot of stock balances per (tenant, item, warehouse).
 * Captured by the retention.cleanup cron (SDD §5.4) so that detail-level
 * stock movements can be archived after 24 months without losing the
 * point-in-time valuation for historical reports.
 */

export interface StockSnapshotEntry {
  itemId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  quantity: number;
  unitCost: number;
  valueBdt: number;
}

export interface StockSnapshotDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  /** Inclusive start of the period covered by the snapshot. */
  periodStart: Date;
  /** Exclusive end of the period covered by the snapshot. */
  periodEnd: Date;
  /** Per (item, warehouse) entries; bounded by tenant SKU * warehouse count. */
  entries: StockSnapshotEntry[];
  totalValueBdt: number;
  totalQuantity: number;
  computedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type StockSnapshotHydrated = HydratedDocument<StockSnapshotDoc>;

const entrySchema = new Schema<StockSnapshotEntry>(
  {
    itemId: { type: Schema.Types.ObjectId, ref: 'Item', required: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    quantity: { type: Number, required: true },
    unitCost: { type: Number, required: true, min: 0 },
    valueBdt: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const stockSnapshotSchema = new Schema<StockSnapshotDoc>(
  {
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    entries: { type: [entrySchema], default: [] },
    totalValueBdt: { type: Number, default: 0, min: 0 },
    totalQuantity: { type: Number, default: 0 },
    computedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

stockSnapshotSchema.index(
  { tenantId: 1, periodStart: 1 },
  { unique: true, name: 'tenant_period_unique' },
);
stockSnapshotSchema.index({ tenantId: 1, periodEnd: -1 });

stockSnapshotSchema.plugin(tenancyPlugin);
stockSnapshotSchema.plugin(auditPlugin);

export const StockSnapshot = model<StockSnapshotDoc>('StockSnapshot', stockSnapshotSchema);
