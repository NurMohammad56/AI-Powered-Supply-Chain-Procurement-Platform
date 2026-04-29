/**
 * Cross-cutting audit log infrastructure (SDD FR-AUTH-14, NFR-SEC-17).
 *
 * - `recordAudit(...)` - the write helper every module calls when a
 *   privileged action occurs.
 * - `AuditLog` model - persisted in `shared/db/auditLog.model.ts`,
 *   re-exported here for ergonomics.
 *
 * The audit READING module (controllers/routes for browsing entries from
 * the dashboard) lives separately under `modules/audit/` (lands in a
 * later prompt) and consumes this surface.
 */

export {
  AuditLog,
  type AuditLogDoc,
  type AuditLogHydrated,
  type AuditTargetKind,
  type AuditChange,
} from '../db/auditLog.model.js';

export {
  recordAudit,
  AuditActions,
  type RecordAuditInput,
  type AuditAction,
} from './audit.service.js';
