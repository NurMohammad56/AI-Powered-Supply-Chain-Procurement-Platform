import { AsyncLocalStorage } from 'node:async_hooks';

import { Types, type Schema } from 'mongoose';

import { logger } from '../../config/logger.js';

/**
 * Control Point 2 of the multi-tenant boundary (SDD §2.4.2).
 *
 * Two protections, one plugin:
 *   1. Pre-find/update/delete hooks inject `tenantId` from the AsyncLocalStorage
 *      scope into the query filter. A query that runs without a tenant scope
 *      is rejected with TENANCY_SCOPE_MISSING - never silently broadened.
 *   2. Pre-save hook sets `tenantId` if absent (from scope) and rejects any
 *      attempt to save a document whose `tenantId` does not match the scope.
 *
 * The scope is established once per authenticated request by the
 * `tenantScope` middleware via `tenantStorage.run(...)`.
 */

export interface TenantStore {
  tenantId: Types.ObjectId;
}

export const tenantStorage = new AsyncLocalStorage<TenantStore>();

export function getTenantScope(): TenantStore | undefined {
  return tenantStorage.getStore();
}

export function requireTenantScope(): TenantStore {
  const store = tenantStorage.getStore();
  if (!store) {
    throw new Error('TENANCY_SCOPE_MISSING: operation attempted without tenant context');
  }
  return store;
}

export interface TenancyPluginOptions {
  /**
   * If true, the plugin is a no-op (the schema is treated as global).
   * Reserved for collections like `factories` (the tenant root) and
   * cross-tenant `auditLogs`. Application code outside this plugin must
   * never bypass tenant isolation; this opt-out is for collections that
   * have no tenant by design.
   */
  skip?: boolean;
}

const QUERY_HOOKS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'countDocuments',
  'estimatedDocumentCount',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
] as const;

export function tenancyPlugin(schema: Schema, opts: TenancyPluginOptions = {}): void {
  if (opts.skip) return;

  // Define the discriminator field if absent. Compound indexes that must
  // start with tenantId are declared per-collection (see SDD §4.3).
  if (!schema.path('tenantId')) {
    schema.add({
      tenantId: {
        type: Types.ObjectId,
        ref: 'Factory',
        required: true,
        index: true,
      },
    });
  }

  for (const hook of QUERY_HOOKS) {
    schema.pre(hook, function preTenantQuery(next) {
      const store = tenantStorage.getStore();
      if (!store) {
        const err = new Error(
          `TENANCY_SCOPE_MISSING: ${hook} on ${this.model.modelName} without tenant context`,
        );
        logger.error({ err, model: this.model.modelName, hook }, 'Tenant scope missing on query');
        return next(err);
      }
      // `where` adds to the existing filter without overwriting unrelated keys.
      this.where({ tenantId: store.tenantId });
      next();
    });
  }

  schema.pre('save', function preTenantSave(next) {
    const store = tenantStorage.getStore();
    if (!store) {
      return next(new Error('TENANCY_SCOPE_MISSING: save without tenant context'));
    }
    const doc = this as unknown as { tenantId?: Types.ObjectId };
    if (!doc.tenantId) {
      doc.tenantId = store.tenantId;
      return next();
    }
    if (!doc.tenantId.equals(store.tenantId)) {
      logger.error(
        {
          event: 'TENANCY_VIOLATION_ON_SAVE',
          docTenantId: doc.tenantId.toString(),
          scopeTenantId: store.tenantId.toString(),
        },
        'Tenant violation blocked on save',
      );
      return next(new Error('TENANCY_VIOLATION: tenantId mismatch on save'));
    }
    next();
  });

  schema.pre('insertMany', function preTenantInsertMany(next, docs) {
    const store = tenantStorage.getStore();
    if (!store) return next(new Error('TENANCY_SCOPE_MISSING: insertMany without tenant context'));
    const items = Array.isArray(docs) ? docs : [docs];
    for (const item of items) {
      const candidate = item as { tenantId?: Types.ObjectId };
      if (!candidate.tenantId) {
        candidate.tenantId = store.tenantId;
      } else if (!candidate.tenantId.equals(store.tenantId)) {
        return next(new Error('TENANCY_VIOLATION: tenantId mismatch on insertMany'));
      }
    }
    next();
  });

  schema.pre('aggregate', function preTenantAggregate(next) {
    const store = tenantStorage.getStore();
    if (!store) return next(new Error('TENANCY_SCOPE_MISSING: aggregate without tenant context'));
    // Prepend a $match stage scoping to the tenant. Application code is
    // free to add additional filtering downstream.
    const pipeline = this.pipeline();
    pipeline.unshift({ $match: { tenantId: store.tenantId } });
    next();
  });
}
