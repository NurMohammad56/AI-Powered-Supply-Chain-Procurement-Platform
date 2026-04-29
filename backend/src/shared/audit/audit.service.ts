import type { Types } from 'mongoose';

import { logger } from '../../config/logger.js';
import { AuditLog, type AuditAction, type AuditLogDoc, type AuditTarget } from './auditLog.model.js';

export interface RecordAuditInput {
  tenantId: Types.ObjectId | null;
  actorUserId: Types.ObjectId | null;
  actorRole?: string | null;
  action: AuditAction | string;
  target: AuditTarget;
  ip?: string | null;
  userAgent?: string | null;
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
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/**
 * Persist a single audit-log entry. Failure to write is logged at warn
 * level but never propagated - audit logging must not block business
 * operations.
 */
export async function recordAudit(input: RecordAuditInput): Promise<AuditLogDoc | null> {
  try {
    const payload =
      input.payload !== undefined && input.payload !== null
        ? (redact(input.payload) as Record<string, unknown>)
        : null;
    const doc = await AuditLog.create({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole ?? null,
      action: input.action,
      target: input.target,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
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
