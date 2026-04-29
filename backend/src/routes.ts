import { Router } from 'express';

import { authPublicRouter, authPrivateRouter, authPrivateMiddleware } from './modules/auth/index.js';
import { resolveTenant, tenantScope } from './shared/middleware/tenant.js';
import { rateLimitAuthenticated, rateLimitTenant } from './shared/middleware/rateLimit.js';

import { inventoryRouter } from './modules/inventory/inventory.routes.js';
import { supplierRouter } from './modules/supplier/supplier.routes.js';
import { quotationRouter, publicQuotationRouter } from './modules/supplier/quotation.routes.js';
import { poRouter } from './modules/po/po.routes.js';
import { aiRouter } from './modules/ai/ai.routes.js';
import { rptRouter } from './modules/rpt/rpt.routes.js';
import { notificationRouter } from './modules/notification/notification.routes.js';
import { billingRouter, webhookRouter } from './modules/billing/billing.routes.js';

/**
 * Top-level v1 router. Mounts each module's public and private routers.
 * Public routers carry no tenant context (auth registration, login,
 * password recovery, token-gated quotation responses, gateway webhooks).
 * Private routers are gated by `resolveTenant` + `tenantScope` and the
 * per-tenant rate limiter.
 */
export function buildApiRouter(): Router {
  const router = Router();

  // Public surface (no JWT)
  router.use('/auth', authPublicRouter);
  router.use('/public/quotations', publicQuotationRouter);
  router.use('/webhooks', webhookRouter);

  // Authenticated surface
  const authenticated = Router();
  authenticated.use(rateLimitAuthenticated);
  authenticated.use(...authPrivateMiddleware);
  authenticated.use(rateLimitTenant);

  authenticated.use('/auth', authPrivateRouter);
  authenticated.use('/inventory', inventoryRouter);
  authenticated.use('/suppliers', supplierRouter);
  authenticated.use('/quotations', quotationRouter);
  authenticated.use('/purchase-orders', poRouter);
  authenticated.use('/ai', aiRouter);
  authenticated.use('/reports', rptRouter);
  authenticated.use('/notifications', notificationRouter);
  authenticated.use('/billing', billingRouter);

  router.use(authenticated);

  // Discovery: trivial endpoint to introspect the API base.
  router.get('/', (_req, res) => {
    res.json({ data: { name: 'scp-platform-api', version: 'v1' } });
  });

  // Reference the unused imports so tree-shaking does not drop the
  // typing they introduce.
  void resolveTenant;
  void tenantScope;

  return router;
}
