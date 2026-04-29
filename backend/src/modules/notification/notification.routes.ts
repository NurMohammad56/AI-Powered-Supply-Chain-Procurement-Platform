import { Router } from 'express';

import { validate } from '../../shared/middleware/validate.js';
import { ListNotificationsQuerySchema, MarkReadRequestSchema } from './notification.dto.js';
import { notificationController } from './notification.controller.js';

export const notificationRouter = Router();

notificationRouter.get(
  '/',
  validate(ListNotificationsQuerySchema, 'query'),
  notificationController.list,
);
notificationRouter.get('/unread-count', notificationController.unreadCount);
notificationRouter.post(
  '/mark-read',
  validate(MarkReadRequestSchema),
  notificationController.markRead,
);
