import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { auditPlugin } from './auditPlugin.js';

/**
 * Append-only privileged-action log (SDD §4.2.6, FR-AUTH-14, NFR-SEC-17).
 *
 * Hot retention: 12 months in this collection. Older entries are moved
 * to `auditLogsArchive` by a scheduled retention job (SDD §4.5).
 *
 * Tenancy posture: tenant-scoped for the vast majority of entries, but
 * `tenantId` is nullable to permit cross-tenant administrative actions
 * (Platform-Administrator role) per SDD §4.2.6. The tenancy plugin is
 * therefore NOT applied; service-layer code must include `tenantId` in
 * every user-facing query.
 *
 * Mutability: there is no update or delete API. Every mutation in the
 * application must instead append a new entry. Mongoose schema does not
 * disable updates entirely (it would block migrations); discipline is
 * enforced at the service layer.
 */

export type AuditTargetKind =
  | 'factory'
  | 'user'
  | 'session'
  | 'item'
  | 'warehouse'
  | 'supplier'
  | 'quotation_request'
  | 'purchase_order'
  | 'po_receipt'
  | 'forecast'
  | 'subscription'
  | 'invoice'
  | 'notification'
  | 'email_delivery';

export interface AuditChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface AuditLogDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId | null;
  actorUserId: Types.ObjectId | null;
  actorRole: string | null;
  action: string;
  target: {
    kind: AuditTargetKind | string;
    id: Types.ObjectId | null;
  };
  ip: string | null;
  userAgent: string | null;
  before: unknown;
  after: unknown;
  changes: AuditChange[];
  payload: Record<string, unknown>;
  requestId: string | null;
  at: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type AuditLogHydrated = HydratedDocument<AuditLogDoc>;

const auditChangeSchema = new Schema<AuditChange>(
  {
    path: { type: String, required: true },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const auditLogSchema = new Schema<AuditLogDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Factory', default: null, index: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorRole: { type: String, default: null, maxlength: 32 },
    action: { type: String, required: true, trim: true, maxlength: 80 },
    target: {
      kind: { type: String, required: true, trim: true, maxlength: 40 },
      id: { type: Schema.Types.ObjectId, default: null },
    },
    ip: { type: String, default: null, maxlength: 64 },
    userAgent: { type: String, default: null, maxlength: 512 },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    changes: { type: [auditChangeSchema], default: [] },
    payload: { type: Schema.Types.Mixed, default: {} },
    requestId: { type: String, default: null, maxlength: 128 },
    at: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true },
);

auditLogSchema.index({ tenantId: 1, at: -1 });
auditLogSchema.index({ tenantId: 1, action: 1, at: -1 });
auditLogSchema.index({ tenantId: 1, 'target.kind': 1, 'target.id': 1, at: -1 });
auditLogSchema.index({ actorUserId: 1, at: -1 });

auditLogSchema.plugin(auditPlugin);

export const AuditLog = model<AuditLogDoc>('AuditLog', auditLogSchema);
