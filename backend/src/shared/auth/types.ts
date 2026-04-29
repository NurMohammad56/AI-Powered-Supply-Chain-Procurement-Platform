import type { Types } from 'mongoose';

export type Role = 'owner' | 'manager' | 'warehouse_staff' | 'viewer';
export const ROLES: readonly Role[] = ['owner', 'manager', 'warehouse_staff', 'viewer'] as const;

export type SubscriptionTier = 'trial' | 'starter' | 'growth' | 'enterprise';
export const TIERS: readonly SubscriptionTier[] = [
  'trial',
  'starter',
  'growth',
  'enterprise',
] as const;

/**
 * Stable string identifier for every fine-grained capability the platform
 * exposes. The full RBAC matrix lives in `rbac.ts`; controllers reference
 * capabilities by name, not by role.
 */
export type Capability =
  // Inventory
  | 'inventory.item.create'
  | 'inventory.item.read'
  | 'inventory.item.update'
  | 'inventory.item.archive'
  | 'inventory.movement.create'
  | 'inventory.warehouse.manage'
  // Supplier
  | 'supplier.create'
  | 'supplier.update'
  | 'supplier.archive'
  | 'supplier.read'
  | 'supplier.quote.send'
  // Purchase orders
  | 'po.create'
  | 'po.update'
  | 'po.submit'
  | 'po.approve'
  | 'po.reject'
  | 'po.dispatch'
  | 'po.receive'
  | 'po.cancel'
  | 'po.read'
  // AI
  | 'ai.forecast.generate'
  | 'ai.forecast.override'
  // Reporting
  | 'rpt.read'
  | 'rpt.export'
  // Users
  | 'user.invite'
  | 'user.role.assign'
  // Billing
  | 'billing.read'
  | 'billing.subscription.change'
  // Audit
  | 'audit.read';

/**
 * Per-request authentication context. Attached to `req.context` by the
 * `resolveTenant` middleware after JWT verification; never derived from any
 * user-supplied input.
 */
export interface TenantContext {
  readonly factoryId: Types.ObjectId;
  readonly userId: Types.ObjectId;
  readonly role: Role;
  readonly subscriptionTier: SubscriptionTier;
  readonly seats: number;
  readonly features: ReadonlySet<string>;
  readonly requestId: string;
}

declare global {
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface Request {
      context?: TenantContext;
      id?: string;
    }
  }
}

export {};
