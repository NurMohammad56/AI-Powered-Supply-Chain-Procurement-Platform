import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';

/**
 * Pre-aggregated daily/weekly/monthly KPI snapshots per tenant.
 * Computed by the report worker on schedule (SDD §13 - keeps dashboard
 * latency low without recomputing aggregations on every page load).
 *
 * Grain is keyed by `period` so a single tenant can hold daily, weekly,
 * and monthly grain side-by-side and the dashboard picks the appropriate
 * resolution for the requested date range.
 */

export type KpiPeriodGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';
export const KPI_PERIODS: readonly KpiPeriodGrain[] = [
  'day',
  'week',
  'month',
  'quarter',
  'year',
] as const;

export interface InventoryKpis {
  itemCount: number;
  archivedItemCount: number;
  totalQuantity: number;
  totalValueBdt: number;
  lowStockItemCount: number;
  deadStockItemCount: number;
  movementCount: number;
}

export interface ProcurementKpis {
  poCount: number;
  draftPoCount: number;
  pendingApprovalCount: number;
  approvedPoCount: number;
  closedPoCount: number;
  spendBdt: number;
  spendUsd: number;
  uniqueSupplierCount: number;
  averageLeadTimeDays: number | null;
  onTimeDeliveryRate: number | null;
}

export interface SupplierKpis {
  activeSupplierCount: number;
  averagePerformanceScore: number | null;
  newSupplierCount: number;
}

export interface AiKpis {
  forecastCount: number;
  failoverCount: number;
  averageForecastLatencyMs: number | null;
  averageMape: number | null;
}

export interface KpiSnapshotDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  period: KpiPeriodGrain;
  /** Inclusive start of the period in UTC. */
  periodStart: Date;
  /** Exclusive end of the period in UTC. */
  periodEnd: Date;
  inventory: InventoryKpis;
  procurement: ProcurementKpis;
  supplier: SupplierKpis;
  ai: AiKpis;
  computedAt: Date;
  /** SDD §6.5 - AI narrative summary of the period; nullable when AI unavailable. */
  narrative: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type KpiSnapshotHydrated = HydratedDocument<KpiSnapshotDoc>;

const inventorySchema = new Schema<InventoryKpis>(
  {
    itemCount: { type: Number, default: 0 },
    archivedItemCount: { type: Number, default: 0 },
    totalQuantity: { type: Number, default: 0 },
    totalValueBdt: { type: Number, default: 0 },
    lowStockItemCount: { type: Number, default: 0 },
    deadStockItemCount: { type: Number, default: 0 },
    movementCount: { type: Number, default: 0 },
  },
  { _id: false },
);

const procurementSchema = new Schema<ProcurementKpis>(
  {
    poCount: { type: Number, default: 0 },
    draftPoCount: { type: Number, default: 0 },
    pendingApprovalCount: { type: Number, default: 0 },
    approvedPoCount: { type: Number, default: 0 },
    closedPoCount: { type: Number, default: 0 },
    spendBdt: { type: Number, default: 0 },
    spendUsd: { type: Number, default: 0 },
    uniqueSupplierCount: { type: Number, default: 0 },
    averageLeadTimeDays: { type: Number, default: null },
    onTimeDeliveryRate: { type: Number, default: null, min: 0, max: 1 },
  },
  { _id: false },
);

const supplierSchema = new Schema<SupplierKpis>(
  {
    activeSupplierCount: { type: Number, default: 0 },
    averagePerformanceScore: { type: Number, default: null, min: 0, max: 100 },
    newSupplierCount: { type: Number, default: 0 },
  },
  { _id: false },
);

const aiSchema = new Schema<AiKpis>(
  {
    forecastCount: { type: Number, default: 0 },
    failoverCount: { type: Number, default: 0 },
    averageForecastLatencyMs: { type: Number, default: null },
    averageMape: { type: Number, default: null, min: 0 },
  },
  { _id: false },
);

const kpiSnapshotSchema = new Schema<KpiSnapshotDoc>(
  {
    period: { type: String, enum: KPI_PERIODS, required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    inventory: { type: inventorySchema, default: () => ({}) },
    procurement: { type: procurementSchema, default: () => ({}) },
    supplier: { type: supplierSchema, default: () => ({}) },
    ai: { type: aiSchema, default: () => ({}) },
    computedAt: { type: Date, default: () => new Date() },
    narrative: { type: String, default: null, maxlength: 4000 },
  },
  { timestamps: true },
);

kpiSnapshotSchema.index(
  { tenantId: 1, period: 1, periodStart: 1 },
  { unique: true, name: 'tenant_period_start_unique' },
);
kpiSnapshotSchema.index({ tenantId: 1, period: 1, periodStart: -1 });

kpiSnapshotSchema.plugin(tenancyPlugin);
kpiSnapshotSchema.plugin(auditPlugin);

export const KpiSnapshot = model<KpiSnapshotDoc>('KpiSnapshot', kpiSnapshotSchema);
