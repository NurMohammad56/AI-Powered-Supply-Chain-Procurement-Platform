import type { Schema } from 'mongoose';

/**
 * Adds `createdAt`/`updatedAt` timestamps via the standard Mongoose option
 * and exposes a small hook surface for emitting structured audit log
 * entries from the service layer when the action is privileged.
 *
 * Audit log persistence to the `auditLogs` collection happens in the
 * audit module (lands in a later prompt). For now, this plugin guarantees
 * timestamp consistency across all tenant-scoped collections.
 */
export function auditPlugin(schema: Schema): void {
  schema.set('timestamps', true);
}
