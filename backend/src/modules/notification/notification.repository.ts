import type { FilterQuery, Types } from 'mongoose';

import { tenantStorage } from '../../shared/db/tenancyPlugin.js';
import { decodeCursor, paginate, type Page } from '../../shared/utils/pagination.js';
import { Notification, type NotificationDoc } from './models/notification.model.js';

export class NotificationRepository {
  async list(args: {
    userId: Types.ObjectId;
    cursor?: string;
    limit: number;
    unreadOnly?: boolean;
    category?: string;
  }): Promise<Page<NotificationDoc>> {
    const filter: FilterQuery<NotificationDoc> = { userId: args.userId };
    if (args.unreadOnly) filter.readAt = null;
    if (args.category) filter.category = args.category;
    const after = decodeCursor(args.cursor);
    if (after) filter._id = { $gt: after };
    const rows = await Notification.find(filter)
      .sort({ _id: 1 })
      .limit(args.limit + 1)
      .lean<NotificationDoc[]>()
      .exec();
    return paginate(rows, args.limit);
  }

  async countUnread(userId: Types.ObjectId): Promise<number> {
    return Notification.countDocuments({ userId, readAt: null }).exec();
  }

  async create(
    input: Omit<NotificationDoc, '_id' | 'tenantId' | 'createdAt' | 'updatedAt'> & {
      tenantId?: Types.ObjectId;
    },
  ): Promise<NotificationDoc> {
    const doc = await Notification.create(input);
    return doc.toObject();
  }

  async markRead(userId: Types.ObjectId, ids: Types.ObjectId[]): Promise<number> {
    const at = new Date();
    const result = await Notification.updateMany(
      { _id: { $in: ids }, userId, readAt: null },
      { $set: { readAt: at } },
    ).exec();
    return result.modifiedCount ?? 0;
  }

  async markAllRead(userId: Types.ObjectId): Promise<number> {
    const at = new Date();
    const result = await Notification.updateMany(
      { userId, readAt: null },
      { $set: { readAt: at } },
    ).exec();
    return result.modifiedCount ?? 0;
  }

  withScope<T>(tenantId: Types.ObjectId, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      tenantStorage.run({ tenantId }, () => {
        fn().then(resolve, reject);
      });
    });
  }
}

export const notificationRepository = new NotificationRepository();
