import { z } from 'zod';

import { objectIdStringSchema } from '../../shared/utils/objectId.js';
import { cursorQuerySchema } from '../../shared/utils/pagination.js';
import { PURCHASE_ORDER_STATES } from './models/purchaseOrder.model.js';

const poLineInputSchema = z.object({
  itemId: objectIdStringSchema,
  quantityOrdered: z.number().positive(),
  unitPrice: z.number().min(0),
  expectedDeliveryAt: z.string().datetime().nullable().optional(),
  remarks: z.string().max(500).nullable().optional(),
});

export const CreatePoRequestSchema = z.object({
  supplierId: objectIdStringSchema,
  warehouseId: objectIdStringSchema,
  currency: z.enum(['BDT', 'USD']).default('BDT'),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
  expectedDeliveryAt: z.string().datetime(),
  lines: z.array(poLineInputSchema).min(1).max(200),
  taxRate: z.number().min(0).max(1).default(0),
});
export type CreatePoRequest = z.infer<typeof CreatePoRequestSchema>;

export const UpdatePoRequestSchema = z.object({
  warehouseId: objectIdStringSchema.optional(),
  currency: z.enum(['BDT', 'USD']).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  expectedDeliveryAt: z.string().datetime().optional(),
  lines: z.array(poLineInputSchema).min(1).max(200).optional(),
  taxRate: z.number().min(0).max(1).optional(),
});
export type UpdatePoRequest = z.infer<typeof UpdatePoRequestSchema>;

export const ListPosQuerySchema = cursorQuerySchema.extend({
  state: z.enum(PURCHASE_ORDER_STATES as unknown as [string, ...string[]]).optional(),
  supplierId: objectIdStringSchema.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  q: z.string().max(64).optional(),
});
export type ListPosQuery = z.infer<typeof ListPosQuerySchema>;

export const PoIdParamSchema = z.object({
  id: objectIdStringSchema,
});
export type PoIdParam = z.infer<typeof PoIdParamSchema>;

export const SubmitPoRequestSchema = z.object({});
export type SubmitPoRequest = z.infer<typeof SubmitPoRequestSchema>;

export const ApprovePoRequestSchema = z.object({
  thresholdRule: z.string().max(80).optional(),
});
export type ApprovePoRequest = z.infer<typeof ApprovePoRequestSchema>;

export const RejectPoRequestSchema = z.object({
  reason: z.string().min(1).max(1000),
});
export type RejectPoRequest = z.infer<typeof RejectPoRequestSchema>;

export const DispatchPoRequestSchema = z.object({
  sentTo: z.string().email().max(254),
});
export type DispatchPoRequest = z.infer<typeof DispatchPoRequestSchema>;

export const CancelPoRequestSchema = z.object({
  reason: z.string().min(1).max(1000),
});
export type CancelPoRequest = z.infer<typeof CancelPoRequestSchema>;

const receiptLineSchema = z.object({
  poLineId: objectIdStringSchema,
  itemId: objectIdStringSchema,
  quantity: z.number().positive(),
  unitCost: z.number().min(0).nullable().optional(),
  qualityNotes: z.string().max(500).nullable().optional(),
});

export const ReceivePoRequestSchema = z.object({
  warehouseId: objectIdStringSchema,
  lines: z.array(receiptLineSchema).min(1).max(200),
  grnDocumentUrl: z.string().url().max(2048).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export type ReceivePoRequest = z.infer<typeof ReceivePoRequestSchema>;

export const CreateFromForecastRequestSchema = z.object({
  itemId: objectIdStringSchema,
  warehouseId: objectIdStringSchema,
  expectedDeliveryAt: z.string().datetime().optional(),
});
export type CreateFromForecastRequest = z.infer<typeof CreateFromForecastRequestSchema>;

// ============ Response views ============
export interface PoLineView {
  id: string;
  itemId: string;
  itemSnapshot: { sku: string; name: string; unit: string };
  quantityOrdered: number;
  quantityReceived: number;
  unitPrice: number;
  lineTotal: number;
  expectedDeliveryAt: string | null;
  remarks: string | null;
}

export interface PoTotalsView {
  subtotal: number;
  tax: number;
  total: number;
}

export interface PoApprovalView {
  submittedAt: string | null;
  submittedBy: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  decision: string | null;
  rejectReason: string | null;
  thresholdRule: string | null;
}

export interface PoDispatchView {
  sentAt: string;
  sentTo: string;
}

export interface PoCancellationView {
  cancelledAt: string;
  cancelledBy: string;
  reason: string;
}

export interface PoView {
  id: string;
  number: string;
  state: string;
  supplierId: string;
  supplierSnapshot: { legalName: string; address: string | null; primaryContactEmail: string | null };
  warehouseId: string;
  currency: string;
  paymentTermsDays: number;
  expectedDeliveryAt: string;
  lines: PoLineView[];
  totals: PoTotalsView;
  pdfUrl: string | null;
  pdfGeneratedAt: string | null;
  approval: PoApprovalView | null;
  dispatch: PoDispatchView | null;
  cancellation: PoCancellationView | null;
  createdBy: string;
  approvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PoReceiptView {
  id: string;
  poId: string;
  poNumber: string;
  receivedAt: string;
  receivedBy: string;
  warehouseId: string;
  lines: Array<{
    poLineId: string;
    itemId: string;
    quantity: number;
    unitCost: number | null;
    qualityNotes: string | null;
  }>;
  grnDocumentUrl: string | null;
  resultingState: string;
  notes: string | null;
}
