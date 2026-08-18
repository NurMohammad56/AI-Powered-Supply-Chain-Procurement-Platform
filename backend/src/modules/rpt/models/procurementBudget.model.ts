import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';

export type BudgetCurrency = 'BDT' | 'USD';

export interface ProcurementBudgetDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  monthStart: Date;
  currency: BudgetCurrency;
  monthlyLimit: number;
  warningThresholdPct: number;
  notes: string | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ProcurementBudgetHydrated = HydratedDocument<ProcurementBudgetDoc>;

const budgetSchema = new Schema<ProcurementBudgetDoc>(
  {
    monthStart: { type: Date, required: true },
    currency: { type: String, enum: ['BDT', 'USD'], required: true, default: 'BDT' },
    monthlyLimit: { type: Number, required: true, min: 0 },
    warningThresholdPct: { type: Number, default: 80, min: 0, max: 100 },
    notes: { type: String, default: null, trim: true, maxlength: 1000 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

budgetSchema.index({ tenantId: 1, monthStart: 1 }, { unique: true });
budgetSchema.index({ tenantId: 1, currency: 1, monthStart: -1 });

budgetSchema.plugin(tenancyPlugin);
budgetSchema.plugin(auditPlugin);

export const ProcurementBudget = model<ProcurementBudgetDoc>('ProcurementBudget', budgetSchema);
