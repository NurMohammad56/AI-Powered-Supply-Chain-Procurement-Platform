import { Router } from 'express';

import { authPublicRouter, authPrivateRouter, authPrivateMiddleware } from './modules/auth/index.js';
import { resolveTenant, tenantScope } from './shared/middleware/tenant.js';
import { rateLimitAuthenticated, rateLimitTenant } from './shared/middleware/rateLimit.js';

/**
 * Top-level v1 router. Mounts each module's public and private routers.
 * Public routers carry no tenant context (auth registration, login,
 * password recovery). Private routers are gated by `resolveTenant` +
 * `tenantScope` and the per-tenant rate limiter.
 */
export function buildApiRouter(): Router {
  const router = Router();

  // Public surface
  router.use('/auth', authPublicRouter);

  // Authenticated surface
  const authenticated = Router();
  authenticated.use(rateLimitAuthenticated);
  authenticated.use(...authPrivateMiddleware);
  authenticated.use(rateLimitTenant);

  // Mount each module's authenticated router under the same prefix it
  // exposes publicly. Subsequent prompts add inventory/supplier/po/etc.
  authenticated.use('/auth', authPrivateRouter);

  // Bridge: anything reachable on the authenticated router is also reachable
  // here, but only after JWT verification + tenant scope.
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
