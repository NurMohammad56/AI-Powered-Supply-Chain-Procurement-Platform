import type { FilterQuery, Types } from 'mongoose';

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
}

export const notificationRepository = new NotificationRepository();
