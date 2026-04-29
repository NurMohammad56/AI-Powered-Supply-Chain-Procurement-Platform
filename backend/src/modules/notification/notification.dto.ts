import { z } from 'zod';

import { objectIdStringSchema } from '../../shared/utils/objectId.js';
import { cursorQuerySchema } from '../../shared/utils/pagination.js';
import { NOTIFICATION_CATEGORIES } from './models/notification.model.js';

export const ListNotificationsQuerySchema = cursorQuerySchema.extend({
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  category: z.enum(NOTIFICATION_CATEGORIES as unknown as [string, ...string[]]).optional(),
});
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuerySchema>;

export const NotificationIdParamSchema = z.object({
  id: objectIdStringSchema,
});
export type NotificationIdParam = z.infer<typeof NotificationIdParamSchema>;

export const MarkReadRequestSchema = z.object({
  ids: z.array(objectIdStringSchema).min(1).max(200).optional(),
  all: z.boolean().optional(),
}).refine((v) => v.all === true || (v.ids && v.ids.length > 0), {
  message: 'Provide either ids[] or all=true',
});
export type MarkReadRequest = z.infer<typeof MarkReadRequestSchema>;

export interface NotificationView {
  id: string;
  category: string;
  title: string;
  body: string;
  link: string | null;
  metadata: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}
