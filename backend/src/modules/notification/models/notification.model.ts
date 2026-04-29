import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';

export type NotificationCategory =
  | 'low_stock'
  | 'po_status'
  | 'delivery_reminder'
  | 'weekly_digest'
  | 'system';

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  'low_stock',
  'po_status',
  'delivery_reminder',
  'weekly_digest',
  'system',
] as const;

/**
 * In-app notification feed entry (FR-NOT-06). One document per
 * (recipient user) — fan-out happens at write time. 90-day TTL on
 * `expiresAt` per SDD §4.5.
 */
export interface NotificationDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  userId: Types.ObjectId;
  category: NotificationCategory;
  title: string;
  body: string;
  link: string | null;
  metadata: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export type NotificationHydrated = HydratedDocument<NotificationDoc>;

const notificationSchema = new Schema<NotificationDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    category: { type: String, enum: NOTIFICATION_CATEGORIES, required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 2000 },
    link: { type: String, default: null, trim: true, maxlength: 1024 },
    metadata: { type: Schema.Types.Mixed, default: {} },
    readAt: { type: Date, default: null },
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true },
);

notificationSchema.index({ tenantId: 1, userId: 1, createdAt: -1 });
notificationSchema.index(
  { tenantId: 1, userId: 1, readAt: 1, createdAt: -1 },
  { name: 'unread_feed', partialFilterExpression: { readAt: null } },
);
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

notificationSchema.plugin(tenancyPlugin);
notificationSchema.plugin(auditPlugin);

export const Notification = model<NotificationDoc>('Notification', notificationSchema);
