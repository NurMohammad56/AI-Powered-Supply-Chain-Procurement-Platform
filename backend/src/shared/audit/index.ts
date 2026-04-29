/**
 * Cross-cutting audit log infrastructure (SDD FR-AUTH-14, NFR-SEC-17).
 *
 * - `recordAudit(...)` - the write helper every module calls when a
 *   privileged action occurs.
 * - `AuditLog` model - the persistence; append-only at the schema level.
 *
 * The audit READING module (controllers/routes) lives separately under
 * `modules/audit/` (lands in a later prompt) and consumes this surface.
 */

export {
  AuditLog,
  type AuditLogDoc,
  type AuditLogHydrated,
  type AuditAction,
  type AuditTarget,
} from './auditLog.model.js';

export {
  recordAudit,
  type RecordAuditInput,
} from './audit.service.js';
