import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

/**
 * Append-only audit log of privileged actions across the platform
 * (FR-AUTH-14, NFR-SEC-17). Lives in `shared/` not `modules/audit/`
 * because:
 *   - every module needs to record entries via `recordAudit(...)`
 *   - the shared audit plugin must be importable without crossing
 *     the module boundary in the wrong direction
 *
 * The `audit` MODULE (lands in a later prompt) provides read-only
 * controllers/routes for browsing this collection from the dashboard.
 *
 * Tenancy: `tenantId` is nullable so cross-tenant Platform-Administrator
 * actions can also be recorded. The tenancy plugin is intentionally
 * NOT registered on this collection - it is treated as a global
 * collection per SDD §2.6 (the `auditLogs` row in the collection
 * inventory). Reads from a tenant-scoped controller MUST manually
 * filter by `tenantId`.
 */

export type AuditAction =
  // Auth
  | 'auth.login.success'
  | 'auth.login.failure'
  | 'auth.logout'
  | 'auth.logout_everywhere'
  | 'auth.refresh.rotation'
  | 'auth.refresh.reuse_detected'
  | 'auth.password.reset_requested'
  | 'auth.password.reset_completed'
  | 'auth.password.changed'
  | 'auth.email.verified'
  | 'auth.account.locked'
  | 'auth.user.invited'
  | 'auth.user.role_changed'
  | 'auth.user.disabled'
  // Inventory
  | 'inventory.item.created'
  | 'inventory.item.updated'
  | 'inventory.item.archived'
  | 'inventory.warehouse.created'
  | 'inventory.warehouse.archived'
  | 'inventory.movement.adjustment'
  // Supplier
  | 'supplier.created'
  | 'supplier.updated'
  | 'supplier.archived'
  | 'supplier.performance_recomputed'
  // Quotation
  | 'quote.request.created'
  | 'quote.response.received'
  | 'quote.accepted'
  // PO
  | 'po.created'
  | 'po.submitted'
  | 'po.approved'
  | 'po.rejected'
  | 'po.dispatched'
  | 'po.received'
  | 'po.closed'
  | 'po.cancelled'
  // AI
  | 'ai.forecast.generated'
  | 'ai.forecast.overridden'
  | 'ai.failover_invoked'
  // Billing
  | 'billing.subscription.created'
  | 'billing.subscription.upgraded'
  | 'billing.subscription.downgraded'
  | 'billing.subscription.cancelled'
  | 'billing.payment.succeeded'
  | 'billing.payment.failed'
  // Tenancy
  | 'tenancy.violation_blocked'
  // Generic - modules can use ad-hoc strings beyond this catalogue when needed
  | 'system.event';

export interface AuditTarget {
  kind: string;
  id: Types.ObjectId | string | null;
}

export interface AuditLogDoc {
  _id: Types.ObjectId;
  /** Null for cross-tenant Platform-Administrator actions. */
  tenantId: Types.ObjectId | null;
  actorUserId: Types.ObjectId | null;
  actorRole: string | null;
  action: AuditAction | string;
  target: AuditTarget;
  ip: string | null;
  userAgent: string | null;
  /** Redacted payload - never raw passwords/tokens. */
  payload: Record<string, unknown> | null;
  requestId: string | null;
  at: Date;
}

export type AuditLogHydrated = HydratedDocument<AuditLogDoc>;

const auditTargetSchema = new Schema<AuditTarget>(
  {
    kind: { type: String, required: true, maxlength: 64 },
    id: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const auditLogSchema = new Schema<AuditLogDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Factory', default: null, index: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorRole: { type: String, default: null, maxlength: 32 },
    action: { type: String, required: true, maxlength: 100 },
    target: { type: auditTargetSchema, required: true },
    ip: { type: String, default: null, maxlength: 64 },
    userAgent: { type: String, default: null, maxlength: 512 },
    payload: { type: Schema.Types.Mixed, default: null },
    requestId: { type: String, default: null, maxlength: 128 },
    at: { type: Date, required: true, default: () => new Date(), index: true },
  },
  // No timestamps - `at` IS the timestamp; this collection is append-only.
  { timestamps: false, versionKey: false },
);

auditLogSchema.index({ tenantId: 1, at: -1 });
auditLogSchema.index({ tenantId: 1, action: 1, at: -1 });
auditLogSchema.index({ tenantId: 1, actorUserId: 1, at: -1 });
auditLogSchema.index({ tenantId: 1, 'target.kind': 1, 'target.id': 1, at: -1 });
auditLogSchema.index({ action: 1, at: -1 });

// Append-only enforcement: forbid update/delete from application code.
auditLogSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'], function (next) {
  next(new Error('AUDIT_LOG_IMMUTABLE: audit log entries cannot be modified'));
});
auditLogSchema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], function (next) {
  next(new Error('AUDIT_LOG_IMMUTABLE: audit log entries cannot be deleted'));
});

// Note: tenancy plugin is intentionally NOT registered. AuditLog is a
// cross-tenant collection by design (see docstring above).

export const AuditLog = model<AuditLogDoc>('AuditLog', auditLogSchema);
