/**
 * Public surface of the notification module.
 */

export {
  Notification,
  NOTIFICATION_CATEGORIES,
  type NotificationDoc,
  type NotificationHydrated,
  type NotificationCategory,
} from './models/notification.model.js';

export {
  EmailDelivery,
  EMAIL_DELIVERY_STATES,
  type EmailDeliveryDoc,
  type EmailDeliveryHydrated,
  type EmailDeliveryState,
} from './models/emailDelivery.model.js';
