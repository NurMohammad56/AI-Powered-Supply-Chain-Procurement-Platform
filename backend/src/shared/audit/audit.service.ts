import type { Types } from 'mongoose';

import { logger } from '../../config/logger.js';
import { AuditLog, type AuditLogDoc, type AuditTargetKind } from '../db/auditLog.model.js';

/**
 * Stable, machine-readable action codes used by `recordAudit`. Modules
 * should reference these constants where possible so audit-log queries
 * have a known vocabulary; ad-hoc strings remain accepted for forward
 * compatibility but are discouraged.
 */
export const AuditActions = {
  // Auth
  AuthLoginSuccess: 'auth.login.success',
  AuthLoginFailure: 'auth.login.failure',
  AuthLogout: 'auth.logout',
  AuthLogoutEverywhere: 'auth.logout_everywhere',
  AuthRefreshRotation: 'auth.refresh.rotation',
  AuthRefreshReuseDetected: 'auth.refresh.reuse_detected',
  AuthPasswordResetRequested: 'auth.password.reset_requested',
  AuthPasswordResetCompleted: 'auth.password.reset_completed',
  AuthPasswordChanged: 'auth.password.changed',
  AuthEmailVerified: 'auth.email.verified',
  AuthAccountLocked: 'auth.account.locked',
  AuthUserInvited: 'auth.user.invited',
  AuthUserRoleChanged: 'auth.user.role_changed',
  AuthUserDisabled: 'auth.user.disabled',

  // Inventory
  InventoryItemCreated: 'inventory.item.created',
  InventoryItemUpdated: 'inventory.item.updated',
  InventoryItemArchived: 'inventory.item.archived',
  InventoryWarehouseCreated: 'inventory.warehouse.created',
  InventoryWarehouseArchived: 'inventory.warehouse.archived',
  InventoryMovementAdjustment: 'inventory.movement.adjustment',

  // Supplier
  SupplierCreated: 'supplier.created',
  SupplierUpdated: 'supplier.updated',
  SupplierArchived: 'supplier.archived',
  SupplierPerformanceRecomputed: 'supplier.performance_recomputed',

  // Quotation
  QuoteRequestCreated: 'quote.request.created',
  QuoteResponseReceived: 'quote.response.received',
  QuoteAccepted: 'quote.accepted',

  // Purchase Order
  PoCreated: 'po.created',
  PoSubmitted: 'po.submitted',
  PoApproved: 'po.approved',
  PoRejected: 'po.rejected',
  PoDispatched: 'po.dispatched',
  PoReceived: 'po.received',
  PoClosed: 'po.closed',
  PoCancelled: 'po.cancelled',

  // AI
  AiForecastGenerated: 'ai.forecast.generated',
  AiForecastOverridden: 'ai.forecast.overridden',
  AiFailoverInvoked: 'ai.failover_invoked',

  // Billing
  BillingSubscriptionCreated: 'billing.subscription.created',
  BillingSubscriptionUpgraded: 'billing.subscription.upgraded',
  BillingSubscriptionDowngraded: 'billing.subscription.downgraded',
  BillingSubscriptionCancelled: 'billing.subscription.cancelled',
  BillingPaymentSucceeded: 'billing.payment.succeeded',
  BillingPaymentFailed: 'billing.payment.failed',

  // Tenancy
  TenancyViolationBlocked: 'tenancy.violation_blocked',

  // Generic
  SystemEvent: 'system.event',
} as const;

export type AuditAction = (typeof AuditActions)[keyof typeof AuditActions];

export interface RecordAuditInput {
  tenantId: Types.ObjectId | null;
  actorUserId: Types.ObjectId | null;
  actorRole?: string | null;
  action: AuditAction | string;
  target: {
    kind: AuditTargetKind | string;
    id: Types.ObjectId | null;
  };
  ip?: string | null;
  userAgent?: string | null;
  before?: unknown;
  after?: unknown;
  payload?: Record<string, unknown> | null;
  requestId?: string | null;
  at?: Date;
}

const SENSITIVE_KEYS = new Set([
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'token',
  'refreshToken',
  'accessToken',
  'jwt',
  'secret',
  'apiKey',
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function diffChanges(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): Array<{ path: string; before: unknown; after: unknown }> {
  if (!before || !after) return [];
  const paths = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  const out: Array<{ path: string; before: unknown; after: unknown }> = [];
  for (const path of paths) {
    const b = before[path];
    const a = after[path];
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      out.push({ path, before: b, after: a });
    }
  }
  return out;
}

/**
 * Persist a single audit-log entry. Failure to write is logged at warn
 * level but never propagated - audit logging must not block business
 * operations.
 */
export async function recordAudit(input: RecordAuditInput): Promise<AuditLogDoc | null> {
  try {
    const before = input.before === undefined ? null : redact(input.before);
    const after = input.after === undefined ? null : redact(input.after);
    const payload =
      input.payload === undefined || input.payload === null
        ? {}
        : (redact(input.payload) as Record<string, unknown>);
    const changes =
      input.before && input.after
        ? diffChanges(
            input.before as Record<string, unknown>,
            input.after as Record<string, unknown>,
          )
        : [];

    const doc = await AuditLog.create({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole ?? null,
      action: input.action,
      target: input.target,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      before,
      after,
      changes,
      payload,
      requestId: input.requestId ?? null,
      at: input.at ?? new Date(),
    });
    return doc.toObject();
  } catch (err) {
    logger.warn(
      {
        err,
        event: 'audit.record_failed',
        action: input.action,
        targetKind: input.target.kind,
      },
      'audit log write failed',
    );
    return null;
  }
}
