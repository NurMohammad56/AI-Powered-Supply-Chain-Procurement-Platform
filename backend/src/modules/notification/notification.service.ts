import { Types } from 'mongoose';

import type { TenantContext } from '../../shared/auth/types.js';
import type { Page } from '../../shared/utils/pagination.js';
import { notificationRepository } from './notification.repository.js';
import type { NotificationDoc } from './models/notification.model.js';
import type { ListNotificationsQuery, MarkReadRequest, NotificationView } from './notification.dto.js';

function toView(n: NotificationDoc): NotificationView {
  return {
    id: n._id.toString(),
    category: n.category,
    title: n.title,
    body: n.body,
    link: n.link,
    metadata: n.metadata,
    readAt: n.readAt ? n.readAt.toISOString() : null,
    createdAt: n.createdAt.toISOString(),
  };
}

function pagedView<T, V>(page: Page<T>, mapper: (row: T) => V) {
  return {
    rows: page.rows.map(mapper),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    limit: page.limit,
  };
}

export class NotificationService {
  async list(ctx: TenantContext, query: ListNotificationsQuery) {
    const page = await notificationRepository.list({
      userId: ctx.userId,
      cursor: query.cursor,
      limit: query.limit,
      unreadOnly: query.unreadOnly,
      category: query.category,
    });
    return pagedView(page, toView);
  }

  async unreadCount(ctx: TenantContext): Promise<{ count: number }> {
    const count = await notificationRepository.countUnread(ctx.userId);
    return { count };
  }

  async markRead(ctx: TenantContext, input: MarkReadRequest): Promise<{ updated: number }> {
    if (input.all) {
      const updated = await notificationRepository.markAllRead(ctx.userId);
      return { updated };
    }
    const ids = (input.ids ?? []).map((id) => new Types.ObjectId(id));
    const updated = await notificationRepository.markRead(ctx.userId, ids);
    return { updated };
  }
}

export const notificationService = new NotificationService();
