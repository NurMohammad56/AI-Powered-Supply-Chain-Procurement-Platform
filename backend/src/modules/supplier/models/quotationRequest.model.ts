import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';

export type QuotationStatus = 'open' | 'closed' | 'cancelled';

export interface QuotationLine {
  itemId: Types.ObjectId;
  quantity: number;
  targetUnitPrice: number | null;
  targetDeliveryDate: Date | null;
  remarks: string | null;
}

export interface QuotationResponseLine {
  itemId: Types.ObjectId;
  unitPrice: number;
  currency: 'BDT' | 'USD';
  moq: number;
  leadTimeDays: number;
  validityDays: number;
  remarks: string | null;
}

export interface QuotationResponse {
  submittedAt: Date;
  lines: QuotationResponseLine[];
  isLate: boolean;
  comments: string | null;
}

export interface QuotationSupplierInvitation {
  supplierId: Types.ObjectId;
  responseToken: string;
  invitedAt: Date;
  invitedContactEmail: string;
  response: QuotationResponse | null;
}

export interface QuotationAiRecommendation {
  rankedSupplierIds: Types.ObjectId[];
  reasoning: string;
  generatedAt: Date;
  provider: 'groq' | 'gemini';
  modelVersion: string;
}

export interface QuotationRequestDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  number: string;
  status: QuotationStatus;
  requestedBy: Types.ObjectId;
  validUntil: Date;
  lines: QuotationLine[];
  supplierInvitations: QuotationSupplierInvitation[];
  aiRecommendation: QuotationAiRecommendation | null;
  acceptedSupplierId: Types.ObjectId | null;
  acceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type QuotationRequestHydrated = HydratedDocument<QuotationRequestDoc>;

const lineSchema = new Schema<QuotationLine>(
  {
    itemId: { type: Schema.Types.ObjectId, ref: 'Item', required: true },
    quantity: { type: Number, required: true, min: 0 },
    targetUnitPrice: { type: Number, default: null, min: 0 },
    targetDeliveryDate: { type: Date, default: null },
    remarks: { type: String, default: null, trim: true, maxlength: 500 },
  },
  { _id: false },
);

const responseLineSchema = new Schema<QuotationResponseLine>(
  {
    itemId: { type: Schema.Types.ObjectId, ref: 'Item', required: true },
    unitPrice: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ['BDT', 'USD'], required: true },
    moq: { type: Number, required: true, min: 0 },
    leadTimeDays: { type: Number, required: true, min: 0, max: 365 },
    validityDays: { type: Number, required: true, min: 1, max: 365 },
    remarks: { type: String, default: null, trim: true, maxlength: 500 },
  },
  { _id: false },
);

const responseSchema = new Schema<QuotationResponse>(
  {
    submittedAt: { type: Date, required: true },
    lines: { type: [responseLineSchema], required: true, default: [] },
    isLate: { type: Boolean, default: false },
    comments: { type: String, default: null, trim: true, maxlength: 2000 },
  },
  { _id: false },
);

const invitationSchema = new Schema<QuotationSupplierInvitation>(
  {
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    responseToken: { type: String, required: true, trim: true, maxlength: 256 },
    invitedAt: { type: Date, required: true, default: () => new Date() },
    invitedContactEmail: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    response: { type: responseSchema, default: null },
  },
  { _id: false },
);

const aiRecommendationSchema = new Schema<QuotationAiRecommendation>(
  {
    rankedSupplierIds: { type: [Schema.Types.ObjectId], ref: 'Supplier', default: [] },
    reasoning: { type: String, required: true, trim: true, maxlength: 4000 },
    generatedAt: { type: Date, required: true, default: () => new Date() },
    provider: { type: String, enum: ['groq', 'gemini'], required: true },
    modelVersion: { type: String, required: true, trim: true, maxlength: 80 },
  },
  { _id: false },
);

const quotationRequestSchema = new Schema<QuotationRequestDoc>(
  {
    number: { type: String, required: true, trim: true, maxlength: 32 },
    status: {
      type: String,
      enum: ['open', 'closed', 'cancelled'],
      default: 'open',
      index: true,
    },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    validUntil: { type: Date, required: true },
    lines: { type: [lineSchema], required: true, default: [] },
    supplierInvitations: { type: [invitationSchema], default: [] },
    aiRecommendation: { type: aiRecommendationSchema, default: null },
    acceptedSupplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', default: null },
    acceptedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

quotationRequestSchema.index({ tenantId: 1, number: 1 }, { unique: true });
quotationRequestSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
quotationRequestSchema.index(
  { 'supplierInvitations.responseToken': 1 },
  { unique: true, partialFilterExpression: { 'supplierInvitations.responseToken': { $type: 'string' } } },
);
quotationRequestSchema.index({ tenantId: 1, requestedBy: 1, createdAt: -1 });

quotationRequestSchema.plugin(tenancyPlugin);
quotationRequestSchema.plugin(auditPlugin);

export const QuotationRequest = model<QuotationRequestDoc>(
  'QuotationRequest',
  quotationRequestSchema,
);
