import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { softDeletePlugin } from '../../../shared/db/softDeletePlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';

export type ItemUnit =
  | 'pcs'
  | 'kg'
  | 'g'
  | 'm'
  | 'cm'
  | 'sqm'
  | 'litre'
  | 'ml'
  | 'box'
  | 'roll'
  | 'sheet'
  | 'pair';

export const ITEM_UNITS: readonly ItemUnit[] = [
  'pcs',
  'kg',
  'g',
  'm',
  'cm',
  'sqm',
  'litre',
  'ml',
  'box',
  'roll',
  'sheet',
  'pair',
] as const;

export type ItemType = 'raw_material' | 'finished_good' | 'packaging' | 'consumable';
export const ITEM_TYPES: readonly ItemType[] = [
  'raw_material',
  'finished_good',
  'packaging',
  'consumable',
] as const;

export type ItemCurrency = 'BDT' | 'USD';

export interface ItemDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  sku: string;
  barcode: string | null;
  name: string;
  description: string | null;
  categoryId: Types.ObjectId | null;
  unit: ItemUnit;
  type: ItemType;
  preferredSupplierId: Types.ObjectId | null;
  reorderLevel: number;
  movingAverageCost: number;
  currency: ItemCurrency;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ItemHydrated = HydratedDocument<ItemDoc>;

const itemSchema = new Schema<ItemDoc>(
  {
    sku: { type: String, required: true, trim: true, uppercase: true, maxlength: 64 },
    barcode: { type: String, default: null, trim: true, maxlength: 64 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: null, trim: true, maxlength: 2000 },
    categoryId: { type: Schema.Types.ObjectId, ref: 'ItemCategory', default: null, index: true },
    unit: { type: String, enum: ITEM_UNITS, required: true },
    type: { type: String, enum: ITEM_TYPES, required: true, index: true },
    preferredSupplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', default: null },
    reorderLevel: { type: Number, default: 0, min: 0 },
    movingAverageCost: { type: Number, default: 0, min: 0 },
    currency: { type: String, enum: ['BDT', 'USD'], default: 'BDT' },
  },
  { timestamps: true },
);

// SDD §4.3 — every compound index leads with tenantId
itemSchema.index({ tenantId: 1, sku: 1 }, { unique: true });
itemSchema.index(
  { tenantId: 1, barcode: 1 },
  { unique: true, partialFilterExpression: { barcode: { $type: 'string' } } },
);
itemSchema.index({ tenantId: 1, archivedAt: 1, type: 1 });
itemSchema.index(
  { tenantId: 1, name: 'text', description: 'text' },
  { name: 'item_text_search', weights: { name: 5, description: 1 } },
);

itemSchema.plugin(tenancyPlugin);
itemSchema.plugin(softDeletePlugin);
itemSchema.plugin(auditPlugin);

export const Item = model<ItemDoc>('Item', itemSchema);
