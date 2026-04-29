import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';

/**
 * Materialised view of current stock quantity per (item, warehouse).
 * The source of truth is `stockMovements` (the append-only ledger);
 * this collection is derived for fast read paths.
 *
 * Concurrent writes use optimistic locking via the `version` field
 * (CAS update on `findOneAndUpdate({ _id, version: N }, { ..., $inc: { version: 1 } })`).
 * SDD §4.2.2.
 */
export interface StockBalanceDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  itemId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  quantity: number;
  reservedQuantity: number;
  reorderLevelOverride: number | null;
  lastMovementAt: Date | null;
  lowStockSince: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export type StockBalanceHydrated = HydratedDocument<StockBalanceDoc>;

const stockBalanceSchema = new Schema<StockBalanceDoc>(
  {
    itemId: { type: Schema.Types.ObjectId, ref: 'Item', required: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    quantity: { type: Number, default: 0, required: true },
    reservedQuantity: { type: Number, default: 0, min: 0 },
    reorderLevelOverride: { type: Number, default: null, min: 0 },
    lastMovementAt: { type: Date, default: null },
    lowStockSince: { type: Date, default: null },
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Atomic upsert key + the only operational lookup path
stockBalanceSchema.index(
  { tenantId: 1, itemId: 1, warehouseId: 1 },
  { unique: true },
);
// Low-stock dashboard: partial index over docs that have crossed threshold.
stockBalanceSchema.index(
  { tenantId: 1, lowStockSince: 1 },
  { partialFilterExpression: { lowStockSince: { $type: 'date' } } },
);
// Per-warehouse listings.
stockBalanceSchema.index({ tenantId: 1, warehouseId: 1, quantity: 1 });

stockBalanceSchema.plugin(tenancyPlugin);
stockBalanceSchema.plugin(auditPlugin);

export const StockBalance = model<StockBalanceDoc>('StockBalance', stockBalanceSchema);
