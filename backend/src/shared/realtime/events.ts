/**
 * Server-to-client event names. Dotted past-tense convention.
 * Adding a new event requires the same review weight as a new REST
 * endpoint (SDD §7.3).
 */

export const SocketEvents = {
  // Inventory
  InventoryBalanceChanged: 'inventory.balance.changed',
  InventoryItemCreated: 'inventory.item.created',
  InventoryItemArchived: 'inventory.item.archived',

  // Purchase orders
  PoStateChanged: 'po.state.changed',
  PoReceived: 'po.received',

  // Suppliers
  SupplierScoreRecomputed: 'supplier.score.recomputed',
  QuoteResponseReceived: 'quote.response.received',

  // AI
  AiForecastCompleted: 'ai.forecast.completed',

  // Notifications
  NotificationCreated: 'notification.created',
  NotificationRead: 'notification.read',

  // Session
  SessionInvalidated: 'session.invalidated',

  // System
  SystemConnected: 'system.connected',
} as const;

export type SocketEventName = (typeof SocketEvents)[keyof typeof SocketEvents];

export interface InventoryBalanceChangedPayload {
  itemId: string;
  warehouseId: string;
  quantity: number;
  lowStock: boolean;
  at: string;
}

export interface PoStateChangedPayload {
  poId: string;
  fromState: string;
  toState: string;
  actorUserId: string;
  at: string;
}

export interface NotificationCreatedPayload {
  notificationId: string;
  category: string;
  title: string;
  link: string;
  createdAt: string;
}

export interface SessionInvalidatedPayload {
  reason: 'logout_everywhere' | 'admin' | 'reuse_detected';
}

export interface SystemConnectedPayload {
  serverTime: string;
  sessionId: string;
}

export type EventPayloadMap = {
  [SocketEvents.InventoryBalanceChanged]: InventoryBalanceChangedPayload;
  [SocketEvents.PoStateChanged]: PoStateChangedPayload;
  [SocketEvents.NotificationCreated]: NotificationCreatedPayload;
  [SocketEvents.SessionInvalidated]: SessionInvalidatedPayload;
  [SocketEvents.SystemConnected]: SystemConnectedPayload;
};

export function tenantRoom(tenantId: string): string {
  return `tenant:${tenantId}`;
}

export function userRoom(userId: string): string {
  return `user:${userId}`;
}
