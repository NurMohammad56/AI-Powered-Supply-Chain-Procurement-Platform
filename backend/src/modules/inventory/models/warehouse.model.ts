import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { softDeletePlugin } from '../../../shared/db/softDeletePlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';

export interface WarehouseAddress {
  street: string;
  city: string;
  country: string;
  postalCode: string | null;
}

export interface WarehouseDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  name: string;
  code: string;
  address: WarehouseAddress | null;
  isActive: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type WarehouseHydrated = HydratedDocument<WarehouseDoc>;

const addressSchema = new Schema<WarehouseAddress>(
  {
    street: { type: String, required: true, trim: true, maxlength: 200 },
    city: { type: String, required: true, trim: true, maxlength: 80 },
    country: { type: String, required: true, trim: true, maxlength: 80, default: 'BD' },
    postalCode: { type: String, default: null, trim: true, maxlength: 20 },
  },
  { _id: false },
);

const warehouseSchema = new Schema<WarehouseDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    address: { type: addressSchema, default: null },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

warehouseSchema.index({ tenantId: 1, code: 1 }, { unique: true });
warehouseSchema.index({ tenantId: 1, isActive: 1, name: 1 });

warehouseSchema.plugin(tenancyPlugin);
warehouseSchema.plugin(softDeletePlugin);
warehouseSchema.plugin(auditPlugin);

export const Warehouse = model<WarehouseDoc>('Warehouse', warehouseSchema);
