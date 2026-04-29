import { z } from 'zod';

import { objectIdStringSchema } from '../../shared/utils/objectId.js';
import { cursorQuerySchema } from '../../shared/utils/pagination.js';

const quotationLineSchema = z.object({
  itemId: objectIdStringSchema,
  quantity: z.number().positive(),
  targetUnitPrice: z.number().min(0).nullable().optional(),
  targetDeliveryDate: z.string().datetime().nullable().optional(),
  remarks: z.string().max(500).nullable().optional(),
});

const invitedSupplierSchema = z.object({
  supplierId: objectIdStringSchema,
  contactEmail: z.string().email().max(254),
});

export const CreateQuotationRequestSchema = z.object({
  validUntil: z.string().datetime(),
  lines: z.array(quotationLineSchema).min(1).max(100),
  invitedSuppliers: z.array(invitedSupplierSchema).min(1).max(20),
});
export type CreateQuotationRequest = z.infer<typeof CreateQuotationRequestSchema>;

export const ListQuotationsQuerySchema = cursorQuerySchema.extend({
  status: z.enum(['open', 'closed', 'cancelled']).optional(),
});
export type ListQuotationsQuery = z.infer<typeof ListQuotationsQuerySchema>;

export const QuotationIdParamSchema = z.object({
  id: objectIdStringSchema,
});
export type QuotationIdParam = z.infer<typeof QuotationIdParamSchema>;

export const QuotationTokenParamSchema = z.object({
  token: z.string().min(16).max(256),
});
export type QuotationTokenParam = z.infer<typeof QuotationTokenParamSchema>;

const responseLineSchema = z.object({
  itemId: objectIdStringSchema,
  unitPrice: z.number().min(0),
  currency: z.enum(['BDT', 'USD']),
  moq: z.number().int().min(0),
  leadTimeDays: z.number().int().min(0).max(365),
  validityDays: z.number().int().min(1).max(365),
  remarks: z.string().max(500).nullable().optional(),
});

export const SubmitQuotationResponseSchema = z.object({
  lines: z.array(responseLineSchema).min(1).max(100),
  comments: z.string().max(2000).nullable().optional(),
});
export type SubmitQuotationResponse = z.infer<typeof SubmitQuotationResponseSchema>;

export const AcceptQuotationRequestSchema = z.object({
  supplierId: objectIdStringSchema,
});
export type AcceptQuotationRequest = z.infer<typeof AcceptQuotationRequestSchema>;

// ============ Response views ============
export interface QuotationLineView {
  itemId: string;
  quantity: number;
  targetUnitPrice: number | null;
  targetDeliveryDate: string | null;
  remarks: string | null;
}

export interface QuotationResponseLineView {
  itemId: string;
  unitPrice: number;
  currency: string;
  moq: number;
  leadTimeDays: number;
  validityDays: number;
  remarks: string | null;
}

export interface QuotationResponseView {
  submittedAt: string;
  lines: QuotationResponseLineView[];
  isLate: boolean;
  comments: string | null;
}

export interface QuotationInvitationView {
  supplierId: string;
  invitedAt: string;
  invitedContactEmail: string;
  response: QuotationResponseView | null;
}

export interface QuotationView {
  id: string;
  number: string;
  status: string;
  requestedBy: string;
  validUntil: string;
  lines: QuotationLineView[];
  supplierInvitations: QuotationInvitationView[];
  acceptedSupplierId: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
