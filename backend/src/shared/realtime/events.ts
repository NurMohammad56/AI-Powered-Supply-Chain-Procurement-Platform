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
  AiForecastBatchProgress: 'ai.forecast.batch.progress',
  AiForecastBatchCompleted: 'ai.forecast.batch.completed',

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

export interface AiForecastCompletedPayload {
  forecastId: string;
  itemId: string;
  horizonDays: number;
  confidence: string;
  generatedAt: string;
}

export interface AiForecastBatchProgressPayload {
  batchJobId: string;
  itemId: string;
  index: number;
  total: number;
  status: 'started' | 'completed' | 'failed';
}

export interface AiForecastBatchCompletedPayload {
  batchJobId: string;
  total: number;
  succeeded: number;
  failed: number;
  durationMs: number;
}

export type EventPayloadMap = {
  [SocketEvents.InventoryBalanceChanged]: InventoryBalanceChangedPayload;
  [SocketEvents.PoStateChanged]: PoStateChangedPayload;
  [SocketEvents.NotificationCreated]: NotificationCreatedPayload;
  [SocketEvents.SessionInvalidated]: SessionInvalidatedPayload;
  [SocketEvents.SystemConnected]: SystemConnectedPayload;
  [SocketEvents.AiForecastCompleted]: AiForecastCompletedPayload;
  [SocketEvents.AiForecastBatchProgress]: AiForecastBatchProgressPayload;
  [SocketEvents.AiForecastBatchCompleted]: AiForecastBatchCompletedPayload;
};

export function tenantRoom(tenantId: string): string {
  return `tenant:${tenantId}`;
}

export function userRoom(userId: string): string {
  return `user:${userId}`;
}
