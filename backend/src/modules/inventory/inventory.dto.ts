import { z } from 'zod';

import { objectIdStringSchema } from '../../shared/utils/objectId.js';
import { cursorQuerySchema } from '../../shared/utils/pagination.js';
import { ITEM_TYPES, ITEM_UNITS } from './models/item.model.js';
import { REASON_CODES } from './models/stockMovement.model.js';

// ============ Warehouses ============
const addressSchema = z.object({
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).nullable().optional(),
  city: z.string().min(1).max(100),
  district: z.string().max(100).nullable().optional(),
  postalCode: z.string().max(20).nullable().optional(),
  country: z.string().length(2).default('BD'),
});

export const CreateWarehouseRequestSchema = z.object({
  name: z.string().min(1).max(120),
  code: z.string().min(1).max(16).toUpperCase(),
  address: addressSchema,
  isActive: z.boolean().default(true),
});
export type CreateWarehouseRequest = z.infer<typeof CreateWarehouseRequestSchema>;

export const UpdateWarehouseRequestSchema = CreateWarehouseRequestSchema.partial();
export type UpdateWarehouseRequest = z.infer<typeof UpdateWarehouseRequestSchema>;

export const ListWarehousesQuerySchema = cursorQuerySchema.extend({
  isActive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  q: z.string().max(100).optional(),
});
export type ListWarehousesQuery = z.infer<typeof ListWarehousesQuerySchema>;

// ============ Item Categories ============
export const CreateItemCategoryRequestSchema = z.object({
  name: z.string().min(1).max(120),
  code: z.string().min(1).max(32).toUpperCase(),
  parentId: objectIdStringSchema.nullable().optional(),
  description: z.string().max(500).nullable().optional(),
});
export type CreateItemCategoryRequest = z.infer<typeof CreateItemCategoryRequestSchema>;

export const UpdateItemCategoryRequestSchema = CreateItemCategoryRequestSchema.partial();
export type UpdateItemCategoryRequest = z.infer<typeof UpdateItemCategoryRequestSchema>;

export const ListItemCategoriesQuerySchema = cursorQuerySchema.extend({
  parentId: objectIdStringSchema.optional(),
  q: z.string().max(100).optional(),
});
export type ListItemCategoriesQuery = z.infer<typeof ListItemCategoriesQuerySchema>;

// ============ Items ============
export const CreateItemRequestSchema = z.object({
  sku: z.string().min(1).max(64).toUpperCase(),
  barcode: z.string().max(64).nullable().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullable().optional(),
  categoryId: objectIdStringSchema.nullable().optional(),
  unit: z.enum(UNITS as unknown as [string, ...string[]]),
  type: z.enum(ITEM_TYPES as unknown as [string, ...string[]]),
  preferredSupplierId: objectIdStringSchema.nullable().optional(),
  reorderLevel: z.number().int().min(0).default(0),
  movingAverageCost: z.number().min(0).default(0),
  currency: z.enum(['BDT', 'USD']).default('BDT'),
});
export type CreateItemRequest = z.infer<typeof CreateItemRequestSchema>;

export const UpdateItemRequestSchema = CreateItemRequestSchema.partial();
export type UpdateItemRequest = z.infer<typeof UpdateItemRequestSchema>;

export const ListItemsQuerySchema = cursorQuerySchema.extend({
  q: z.string().max(100).optional(),
  type: z.enum(ITEM_TYPES as unknown as [string, ...string[]]).optional(),
  categoryId: objectIdStringSchema.optional(),
  supplierId: objectIdStringSchema.optional(),
  archived: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});
export type ListItemsQuery = z.infer<typeof ListItemsQuerySchema>;

// ============ Stock Adjustment ============
export const StockAdjustmentRequestSchema = z.object({
  warehouseId: objectIdStringSchema,
  /** Signed delta - positive increases stock, negative decreases. */
  quantityDelta: z.number().refine((v) => v !== 0, 'quantityDelta must be non-zero'),
  reasonCode: z.enum(REASON_CODES as unknown as [string, ...string[]]),
  notes: z.string().max(1000).optional(),
  attachmentUrl: z.string().url().max(1024).optional(),
});
export type StockAdjustmentRequest = z.infer<typeof StockAdjustmentRequestSchema>;

// ============ Stock Transfer ============
export const StockTransferRequestSchema = z.object({
  fromWarehouseId: objectIdStringSchema,
  toWarehouseId: objectIdStringSchema,
  quantity: z.number().positive(),
  notes: z.string().max(1000).optional(),
});
export type StockTransferRequest = z.infer<typeof StockTransferRequestSchema>;

// ============ Stock IN/OUT (low-level) ============
export const StockInRequestSchema = z.object({
  warehouseId: objectIdStringSchema,
  quantity: z.number().positive(),
  unitCost: z.number().min(0).optional(),
  reasonCode: z.enum(REASON_CODES as unknown as [string, ...string[]]),
  reference: z
    .object({
      kind: z.enum([
        'po_receipt',
        'po_receipt_partial',
        'transfer',
        'adjustment',
        'opening',
        'sale',
        'production',
      ]),
      id: objectIdStringSchema.nullable().optional(),
    })
    .optional(),
  notes: z.string().max(1000).optional(),
});
export type StockInRequest = z.infer<typeof StockInRequestSchema>;

// ============ Movement History ============
export const ItemHistoryQuerySchema = cursorQuerySchema.extend({
  warehouseId: objectIdStringSchema.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  type: z
    .enum(['in', 'out', 'transfer_in', 'transfer_out', 'adjustment', 'opening_balance'])
    .optional(),
});
export type ItemHistoryQuery = z.infer<typeof ItemHistoryQuerySchema>;

// ============ Low Stock ============
export const LowStockQuerySchema = cursorQuerySchema.extend({
  warehouseId: objectIdStringSchema.optional(),
});
export type LowStockQuery = z.infer<typeof LowStockQuerySchema>;

// ============ Bulk Import ============
export const BulkImportRequestSchema = z.object({
  items: z
    .array(
      z.object({
        sku: z.string().min(1).max(64),
        name: z.string().min(1).max(200),
        unit: z.enum(UNITS as unknown as [string, ...string[]]),
        type: z.enum(ITEM_TYPES as unknown as [string, ...string[]]),
        barcode: z.string().max(64).nullable().optional(),
        description: z.string().max(1000).nullable().optional(),
        categoryCode: z.string().max(32).optional(),
        reorderLevel: z.number().int().min(0).default(0),
        openingBalance: z
          .object({
            warehouseCode: z.string().max(16),
            quantity: z.number().min(0),
            unitCost: z.number().min(0).optional(),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(2000),
  /** When true, abort on first error; when false, skip errored rows (atomic vs partial). */
  atomic: z.boolean().default(true),
});
export type BulkImportRequest = z.infer<typeof BulkImportRequestSchema>;

// ============ Path params ============
export const ItemIdParamSchema = z.object({
  id: objectIdStringSchema,
});
export type ItemIdParam = z.infer<typeof ItemIdParamSchema>;

export const WarehouseIdParamSchema = z.object({
  id: objectIdStringSchema,
});
export type WarehouseIdParam = z.infer<typeof WarehouseIdParamSchema>;

export const CategoryIdParamSchema = z.object({
  id: objectIdStringSchema,
});
export type CategoryIdParam = z.infer<typeof CategoryIdParamSchema>;

// ============ Response views ============
export interface WarehouseView {
  id: string;
  name: string;
  code: string;
  address: {
    line1: string;
    line2: string | null;
    city: string;
    district: string | null;
    postalCode: string | null;
    country: string;
  };
  isActive: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ItemCategoryView {
  id: string;
  name: string;
  code: string;
  parentId: string | null;
  description: string | null;
  archivedAt: string | null;
}

export interface ItemView {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  description: string | null;
  categoryId: string | null;
  unit: string;
  type: string;
  preferredSupplierId: string | null;
  reorderLevel: number;
  movingAverageCost: number;
  currency: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StockBalanceView {
  itemId: string;
  warehouseId: string;
  quantity: number;
  reservedQuantity: number;
  reorderLevelOverride: number | null;
  lowStockSince: string | null;
  lastMovementAt: string | null;
}

export interface StockMovementView {
  id: string;
  itemId: string;
  warehouseId: string;
  type: string;
  quantity: number;
  unitCost: number | null;
  reasonCode: string;
  reference: { kind: string; id: string | null };
  attachmentUrl: string | null;
  notes: string | null;
  performedBy: string;
  performedAt: string;
}

export interface BulkImportResult {
  imported: number;
  skipped: number;
  errors: Array<{ row: number; sku: string; message: string }>;
}
