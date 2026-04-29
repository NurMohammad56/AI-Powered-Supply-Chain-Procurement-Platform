import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { softDeletePlugin } from '../../../shared/db/softDeletePlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';

export interface ItemCategoryDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  name: string;
  parentId: Types.ObjectId | null;
  description: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ItemCategoryHydrated = HydratedDocument<ItemCategoryDoc>;

const itemCategorySchema = new Schema<ItemCategoryDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    parentId: { type: Schema.Types.ObjectId, ref: 'ItemCategory', default: null },
    description: { type: String, default: null, trim: true, maxlength: 500 },
  },
  { timestamps: true },
);

itemCategorySchema.index({ tenantId: 1, name: 1 }, { unique: true });
itemCategorySchema.index({ tenantId: 1, parentId: 1 });

itemCategorySchema.plugin(tenancyPlugin);
itemCategorySchema.plugin(softDeletePlugin);
itemCategorySchema.plugin(auditPlugin);

export const ItemCategory = model<ItemCategoryDoc>('ItemCategory', itemCategorySchema);
