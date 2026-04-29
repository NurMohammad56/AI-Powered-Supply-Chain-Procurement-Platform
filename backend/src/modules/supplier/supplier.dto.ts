import { z } from 'zod';

import { objectIdStringSchema } from '../../shared/utils/objectId.js';
import { cursorQuerySchema } from '../../shared/utils/pagination.js';

const addressSchema = z.object({
  street: z.string().min(1).max(200),
  city: z.string().min(1).max(80),
  country: z.string().max(80).default('BD'),
  postalCode: z.string().max(20).nullable().optional(),
});

const contactSchema = z.object({
  name: z.string().min(1).max(120),
  designation: z.string().max(80).nullable().optional(),
  email: z.string().email().max(254),
  phone: z.string().max(40).nullable().optional(),
  isPrimary: z.boolean().default(false),
});

export const CreateSupplierRequestSchema = z.object({
  legalName: z.string().min(1).max(200),
  tradingName: z.string().max(200).nullable().optional(),
  taxId: z.string().max(50).nullable().optional(),
  status: z.enum(['active', 'inactive']).default('active'),
  address: addressSchema.nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
  leadTimeDays: z.number().int().min(0).max(365).default(14),
  contacts: z.array(contactSchema).max(20).default([]),
  categoryIds: z.array(objectIdStringSchema).default([]),
  tier: z.enum(['strategic', 'preferred', 'backup']).default('preferred'),
});
export type CreateSupplierRequest = z.infer<typeof CreateSupplierRequestSchema>;

export const UpdateSupplierRequestSchema = CreateSupplierRequestSchema.partial();
export type UpdateSupplierRequest = z.infer<typeof UpdateSupplierRequestSchema>;

export const ListSuppliersQuerySchema = cursorQuerySchema.extend({
  q: z.string().max(100).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  tier: z.enum(['strategic', 'preferred', 'backup']).optional(),
  categoryId: objectIdStringSchema.optional(),
});
export type ListSuppliersQuery = z.infer<typeof ListSuppliersQuerySchema>;

export const SupplierIdParamSchema = z.object({
  id: objectIdStringSchema,
});
export type SupplierIdParam = z.infer<typeof SupplierIdParamSchema>;

export const ContactIndexParamSchema = z.object({
  id: objectIdStringSchema,
  contactIndex: z.coerce.number().int().min(0).max(19),
});
export type ContactIndexParam = z.infer<typeof ContactIndexParamSchema>;

export const DocumentIndexParamSchema = z.object({
  id: objectIdStringSchema,
  documentIndex: z.coerce.number().int().min(0).max(99),
});
export type DocumentIndexParam = z.infer<typeof DocumentIndexParamSchema>;

export const AddContactRequestSchema = contactSchema;
export type AddContactRequest = z.infer<typeof AddContactRequestSchema>;

export const UpdateContactRequestSchema = contactSchema.partial();
export type UpdateContactRequest = z.infer<typeof UpdateContactRequestSchema>;

export const AddDocumentRequestSchema = z.object({
  kind: z.enum(['contract', 'cert', 'nda', 'invoice', 'other']),
  url: z.string().url().max(2048),
});
export type AddDocumentRequest = z.infer<typeof AddDocumentRequestSchema>;

export const CompareSuppliersQuerySchema = z.object({
  ids: z
    .string()
    .min(1)
    .transform((s) => s.split(',').map((v) => v.trim()).filter((v) => v.length > 0))
    .pipe(z.array(objectIdStringSchema).min(2).max(5)),
});
export type CompareSuppliersQuery = z.infer<typeof CompareSuppliersQuerySchema>;

// ============ Response views ============
export interface SupplierContactView {
  name: string;
  designation: string | null;
  email: string;
  phone: string | null;
  isPrimary: boolean;
}

export interface SupplierAddressView {
  street: string;
  city: string;
  country: string;
  postalCode: string | null;
}

export interface SupplierDocumentView {
  kind: string;
  url: string;
  uploadedAt: string;
}

export interface SupplierPerformanceView {
  overall: number | null;
  onTimeDeliveryRate: number | null;
  qualityRejectRate: number | null;
  priceCompetitiveness: number | null;
  sampleSize: number;
  computedAt: string | null;
}

export interface SupplierView {
  id: string;
  legalName: string;
  tradingName: string | null;
  taxId: string | null;
  status: string;
  address: SupplierAddressView | null;
  paymentTermsDays: number;
  leadTimeDays: number;
  contacts: SupplierContactView[];
  categoryIds: string[];
  tier: string;
  performanceScore: SupplierPerformanceView;
  documents: SupplierDocumentView[];
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
