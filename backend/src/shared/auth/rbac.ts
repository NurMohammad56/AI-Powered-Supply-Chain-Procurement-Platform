import type { Capability, Role } from './types.js';

/**
 * RBAC capability matrix (SDD §9.3). Capabilities are fine-grained verbs
 * scoped to module entities; roles are bundles of capabilities. Controllers
 * gate by capability via `rbacFor("capability.name")`, never by role string.
 *
 * Threshold-bound capabilities (e.g. Manager's `po.approve` above a tenant
 * configurable monetary cap) are encoded in service-layer logic, not here.
 */
const MATRIX: Readonly<Record<Role, ReadonlySet<Capability>>> = {
  owner: new Set<Capability>([
    'inventory.item.create',
    'inventory.item.read',
    'inventory.item.update',
    'inventory.item.archive',
    'inventory.movement.create',
    'inventory.warehouse.manage',
    'supplier.create',
    'supplier.update',
    'supplier.archive',
    'supplier.read',
    'supplier.quote.send',
    'po.create',
    'po.update',
    'po.submit',
    'po.approve',
    'po.reject',
    'po.dispatch',
    'po.receive',
    'po.cancel',
    'po.read',
    'ai.forecast.generate',
    'ai.forecast.override',
    'rpt.read',
    'rpt.export',
    'user.invite',
    'user.role.assign',
    'billing.read',
    'billing.subscription.change',
    'audit.read',
  ]),
  manager: new Set<Capability>([
    'inventory.item.create',
    'inventory.item.read',
    'inventory.item.update',
    'inventory.item.archive',
    'inventory.movement.create',
    'supplier.create',
    'supplier.update',
    'supplier.archive',
    'supplier.read',
    'supplier.quote.send',
    'po.create',
    'po.update',
    'po.submit',
    'po.approve',
    'po.reject',
    'po.dispatch',
    'po.receive',
    'po.read',
    'ai.forecast.generate',
    'ai.forecast.override',
    'rpt.read',
    'rpt.export',
    'user.invite',
  ]),
  warehouse_staff: new Set<Capability>([
    'inventory.item.read',
    'inventory.movement.create',
    'po.receive',
    'po.read',
    'supplier.read',
  ]),
  viewer: new Set<Capability>([
    'inventory.item.read',
    'supplier.read',
    'po.read',
    'rpt.read',
    'rpt.export',
  ]),
};

export function roleHasCapability(role: Role, capability: Capability): boolean {
  return MATRIX[role].has(capability);
}

export function capabilitiesFor(role: Role): readonly Capability[] {
  return Array.from(MATRIX[role]);
}

/**
 * Roles a given role is allowed to assign on `user.invite` / role-change.
 * Owner can assign any role; Manager can assign manager-or-below to prevent
 * lateral privilege escalation (SDD §9.3).
 */
export function assignableRolesBy(actorRole: Role): readonly Role[] {
  switch (actorRole) {
    case 'owner':
      return ['owner', 'manager', 'warehouse_staff', 'viewer'];
    case 'manager':
      return ['manager', 'warehouse_staff', 'viewer'];
    default:
      return [];
  }
}
