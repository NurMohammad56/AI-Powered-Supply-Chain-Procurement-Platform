import { Router, raw } from 'express';

import { validate } from '../../shared/middleware/validate.js';
import { rbacFor } from '../../shared/middleware/rbac.js';
import { idempotencyKey } from '../../shared/middleware/idempotency.js';
import { rateLimitWebhook } from '../../shared/middleware/rateLimit.js';
import {
  CancelSubscriptionRequestSchema,
  ChangeSubscriptionRequestSchema,
  CreateCheckoutSessionRequestSchema,
  CreatePortalSessionRequestSchema,
  ListInvoicesQuerySchema,
  RestartTrialRequestSchema,
} from './billing.dto.js';
import { billingController } from './billing.controller.js';

/**
 * Authenticated billing routes - mounted under `/api/billing`.
 */
export const billingRouter = Router();
billingRouter.post(
  '/trial/restart',
  rbacFor('billing.subscription.change'),
  idempotencyKey,
  validate(RestartTrialRequestSchema),
  billingController.restartTrial,
);
billingRouter.post(
  '/portal-session',
  rbacFor('billing.subscription.change'),
  validate(CreatePortalSessionRequestSchema),
  billingController.createPortalSession,
);

billingRouter.get('/plans', billingController.listPlans);
billingRouter.get('/subscription', rbacFor('billing.read'), billingController.getSubscription);
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
 * Webhook router - mounted under `/api/v1/webhooks` with NO JWT.
 * Stripe authenticates the exact raw payload through its timestamped signature.
 *
 * Rate limit: 1000 req/min per IP (Prompt 06 §5). Legitimate gateway
 * traffic can spike during settlement windows; signature verification
 * is the real authn gate.
 */
export const webhookRouter = Router();

webhookRouter.use(rateLimitWebhook);

webhookRouter.post(
  '/stripe',
  raw({ type: 'application/json', limit: '1mb' }),
  billingController.webhookStripe,
);
