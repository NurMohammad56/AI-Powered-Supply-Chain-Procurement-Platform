import type { Schema } from 'mongoose';

/**
 * Soft-delete plugin (SDD §4.4).
 *
 * Adds an indexed `archivedAt: Date | null` field. By default, queries
 * exclude archived documents. Pass `{ includeArchived: true }` in the
 * filter to opt in to historical reads (used by reporting screens that
 * surface closed POs against deactivated suppliers, etc.).
 */
export function softDeletePlugin(schema: Schema): void {
  if (!schema.path('archivedAt')) {
    schema.add({
      archivedAt: { type: Date, default: null, index: true },
    });
  }

  const READ_HOOKS = ['find', 'findOne', 'countDocuments', 'estimatedDocumentCount'] as const;

  for (const hook of READ_HOOKS) {
    schema.pre(hook, function preSoftDelete(next) {
      const filter = this.getFilter() as Record<string, unknown> & {
        includeArchived?: boolean;
        archivedAt?: unknown;
      };
      if (filter.includeArchived) {
        delete filter.includeArchived;
      } else if (filter.archivedAt === undefined) {
        this.where({ archivedAt: null });
      }
      next();
    });
  }

  schema.method('softDelete', async function softDelete(this: { archivedAt: Date | null; save: () => Promise<unknown> }) {
    this.archivedAt = new Date();
    await this.save();
  });
}
