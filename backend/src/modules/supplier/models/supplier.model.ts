import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { softDeletePlugin } from '../../../shared/db/softDeletePlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';

export type SupplierStatus = 'active' | 'inactive';
export type SupplierTier = 'strategic' | 'preferred' | 'backup';

export interface SupplierContact {
  name: string;
  designation: string | null;
  email: string;
  phone: string | null;
  isPrimary: boolean;
}

export interface SupplierAddress {
  street: string;
  city: string;
  country: string;
  postalCode: string | null;
}

export type SupplierDocumentKind = 'contract' | 'cert' | 'nda' | 'invoice' | 'other';

export interface SupplierDocumentRef {
  kind: SupplierDocumentKind;
  url: string;
  uploadedAt: Date;
}

export interface SupplierPerformanceScore {
  overall: number | null;
  onTimeDeliveryRate: number | null;
  qualityRejectRate: number | null;
  priceCompetitiveness: number | null;
  sampleSize: number;
  computedAt: Date | null;
}

export interface SupplierDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalName: string;
  tradingName: string | null;
  taxId: string | null;
  status: SupplierStatus;
  address: SupplierAddress | null;
  paymentTermsDays: number;
  leadTimeDays: number;
  contacts: SupplierContact[];
  categoryIds: Types.ObjectId[];
  tier: SupplierTier;
  performanceScore: SupplierPerformanceScore;
  documentUrls: SupplierDocumentRef[];
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type SupplierHydrated = HydratedDocument<SupplierDoc>;

const contactSchema = new Schema<SupplierContact>(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    designation: { type: String, default: null, trim: true, maxlength: 80 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    phone: { type: String, default: null, trim: true, maxlength: 40 },
    isPrimary: { type: Boolean, default: false },
  },
  { _id: false },
);

const addressSchema = new Schema<SupplierAddress>(
  {
    street: { type: String, required: true, trim: true, maxlength: 200 },
    city: { type: String, required: true, trim: true, maxlength: 80 },
    country: { type: String, required: true, trim: true, maxlength: 80, default: 'BD' },
    postalCode: { type: String, default: null, trim: true, maxlength: 20 },
  },
  { _id: false },
);

const documentRefSchema = new Schema<SupplierDocumentRef>(
  {
    kind: {
      type: String,
      enum: ['contract', 'cert', 'nda', 'invoice', 'other'],
      required: true,
    },
    url: { type: String, required: true, trim: true, maxlength: 2048 },
    uploadedAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

const performanceScoreSchema = new Schema<SupplierPerformanceScore>(
  {
    overall: { type: Number, default: null, min: 0, max: 100 },
    onTimeDeliveryRate: { type: Number, default: null, min: 0, max: 1 },
    qualityRejectRate: { type: Number, default: null, min: 0, max: 1 },
    priceCompetitiveness: { type: Number, default: null, min: 0, max: 100 },
    sampleSize: { type: Number, default: 0, min: 0 },
    computedAt: { type: Date, default: null },
  },
  { _id: false },
);

const supplierSchema = new Schema<SupplierDoc>(
  {
    legalName: { type: String, required: true, trim: true, maxlength: 200 },
    tradingName: { type: String, default: null, trim: true, maxlength: 200 },
    taxId: { type: String, default: null, trim: true, maxlength: 50 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },
    address: { type: addressSchema, default: null },
    paymentTermsDays: { type: Number, default: 30, min: 0, max: 365 },
    leadTimeDays: { type: Number, default: 14, min: 0, max: 365 },
    contacts: {
      type: [contactSchema],
      default: [],
      validate: {
        validator: (v: SupplierContact[]) => v.length <= 20,
        message: 'A supplier may have at most 20 contacts',
      },
    },
    categoryIds: { type: [Schema.Types.ObjectId], ref: 'ItemCategory', default: [] },
    tier: {
      type: String,
      enum: ['strategic', 'preferred', 'backup'],
      default: 'preferred',
    },
    performanceScore: { type: performanceScoreSchema, default: () => ({ sampleSize: 0 }) },
    documentUrls: { type: [documentRefSchema], default: [] },
  },
  { timestamps: true },
);

supplierSchema.index({ tenantId: 1, status: 1, legalName: 1 });
supplierSchema.index(
  { tenantId: 1, taxId: 1 },
  { unique: true, partialFilterExpression: { taxId: { $type: 'string' } } },
);
supplierSchema.index({ tenantId: 1, 'performanceScore.overall': -1 });
supplierSchema.index({ tenantId: 1, archivedAt: 1 });
supplierSchema.index(
  { tenantId: 1, legalName: 'text', tradingName: 'text' },
  { name: 'supplier_text_search', weights: { legalName: 5, tradingName: 3 } },
);

supplierSchema.plugin(tenancyPlugin);
supplierSchema.plugin(softDeletePlugin);
supplierSchema.plugin(auditPlugin);

export const Supplier = model<SupplierDoc>('Supplier', supplierSchema);
