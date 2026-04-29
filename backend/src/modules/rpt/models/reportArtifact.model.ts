import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';

/**
 * Persistent record of every generated report (PDF digests, CSV exports,
 * ad-hoc dashboard PDFs). The actual binary lives on Cloudflare R2; this
 * collection stores the metadata + signed-URL audit trail.
 */

export type ReportKind =
  | 'weekly_digest'
  | 'inventory_turnover'
  | 'procurement_spend'
  | 'supplier_cost_comparison'
  | 'cash_flow_projection'
  | 'csv_export';

export const REPORT_KINDS: readonly ReportKind[] = [
  'weekly_digest',
  'inventory_turnover',
  'procurement_spend',
  'supplier_cost_comparison',
  'cash_flow_projection',
  'csv_export',
] as const;

export type ReportFormat = 'pdf' | 'csv' | 'xlsx';

export type ReportStatus = 'pending' | 'rendering' | 'ready' | 'failed';

export interface ReportArtifactDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  kind: ReportKind;
  format: ReportFormat;
  status: ReportStatus;
  /** Object key in Cloudflare R2 (private bucket; signed-URL access only). */
  objectKey: string | null;
  byteSize: number | null;
  rangeFrom: Date;
  rangeTo: Date;
  filters: Record<string, unknown>;
  requestedBy: Types.ObjectId;
  generatedAt: Date | null;
  /** TTL for the artifact - CSV exports expire after 30d, PDFs retained per SDD §4.5. */
  expiresAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ReportArtifactHydrated = HydratedDocument<ReportArtifactDoc>;

const reportArtifactSchema = new Schema<ReportArtifactDoc>(
  {
    kind: { type: String, enum: REPORT_KINDS, required: true, index: true },
    format: { type: String, enum: ['pdf', 'csv', 'xlsx'], required: true },
    status: {
      type: String,
      enum: ['pending', 'rendering', 'ready', 'failed'],
      default: 'pending',
      index: true,
    },
    objectKey: { type: String, default: null, maxlength: 512 },
    byteSize: { type: Number, default: null, min: 0 },
    rangeFrom: { type: Date, required: true },
    rangeTo: { type: Date, required: true },
    filters: { type: Schema.Types.Mixed, default: {} },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    generatedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    errorCode: { type: String, default: null, maxlength: 64 },
    errorMessage: { type: String, default: null, maxlength: 1000 },
  },
  { timestamps: true },
);

reportArtifactSchema.index({ tenantId: 1, kind: 1, createdAt: -1 });
reportArtifactSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
reportArtifactSchema.index({ tenantId: 1, requestedBy: 1, createdAt: -1 });
reportArtifactSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

reportArtifactSchema.plugin(tenancyPlugin);
reportArtifactSchema.plugin(auditPlugin);

export const ReportArtifact = model<ReportArtifactDoc>('ReportArtifact', reportArtifactSchema);
