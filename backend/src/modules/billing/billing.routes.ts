import { Router, raw } from 'express';

import { validate } from '../../shared/middleware/validate.js';
import { rbacFor } from '../../shared/middleware/rbac.js';
import { idempotencyKey } from '../../shared/middleware/idempotency.js';
import {
  CancelSubscriptionRequestSchema,
  ChangeSubscriptionRequestSchema,
  CreateCheckoutSessionRequestSchema,
  ListInvoicesQuerySchema,
} from './billing.dto.js';
import { billingController } from './billing.controller.js';

/**
 * Authenticated billing routes - mounted under `/api/billing`.
 */
export const billingRouter = Router();

billingRouter.get('/plans', billingController.listPlans);
billingRouter.get(
  '/subscription',
  rbacFor('billing.read'),
  billingController.getSubscription,
);
billingRouter.post(
  '/checkout-session',
  rbacFor('billing.subscription.change'),
  idempotencyKey,
  validate(CreateCheckoutSessionRequestSchema),
  billingController.createCheckoutSession,
);
billingRouter.post(
  '/subscription/change',
  rbacFor('billing.subscription.change'),
  idempotencyKey,
  validate(ChangeSubscriptionRequestSchema),
  billingController.changeSubscription,
);
billingRouter.post(
  '/subscription/cancel',
  rbacFor('billing.subscription.change'),
  idempotencyKey,
  validate(CancelSubscriptionRequestSchema),
  billingController.cancelSubscription,
);
billingRouter.get(
  '/invoices',
  rbacFor('billing.read'),
  validate(ListInvoicesQuerySchema, 'query'),
  billingController.listInvoices,
);

/**
 * Webhook router - mounted under `/api/webhooks` with NO JWT.
 * Each webhook uses raw-body parsing for signature verification by the
 * gateway adapter (lands in a later prompt).
 */
export const webhookRouter = Router();

webhookRouter.post(
  '/stripe',
  raw({ type: 'application/json', limit: '1mb' }),
  billingController.webhookStripe,
);
webhookRouter.post(
  '/sslcommerz',
  raw({ type: '*/*', limit: '1mb' }),
  billingController.webhookSslCommerz,
);
