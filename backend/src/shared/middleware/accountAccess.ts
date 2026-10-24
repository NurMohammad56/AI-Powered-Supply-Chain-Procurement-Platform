import type { RequestHandler } from 'express';
import { ForbiddenError } from '../errors/HttpErrors.js';
import type { Feature } from '../../modules/billing/plans.js';
export const accountAccess: RequestHandler = (req, _res, next) => {
  const ctx = req.context;
  if (!ctx) return next();
  const path = req.path;
  const accountAction =
    path.startsWith('/auth/') &&
    ([
      '/auth/me',
      '/auth/access',
      '/auth/change-password',
      '/auth/logout-everywhere',
      '/auth/resend-verification',
    ].includes(path) ||
      (req.method === 'GET' && path === '/auth/users') ||
      (req.method === 'DELETE' && /^\/auth\/users\/[^/]+$/.test(path)));
  const onboardingAction = [
    '/auth/me',
    '/auth/access',
    '/auth/change-password',
    '/auth/logout-everywhere',
    '/auth/resend-verification',
  ].includes(path);
  if (onboardingAction || path.startsWith('/billing/')) return next();
  if (!ctx.emailVerified)
    return next(
      new ForbiddenError('EMAIL_VERIFICATION_REQUIRED', 'Verify your email to use the product'),
    );
  if (ctx.accessMode === 'suspended')
    return next(new ForbiddenError('COMPANY_SUSPENDED', 'Company access suspended'));
  if (accountAction) return next();
  const aiComparison =
    /^\/quotations\/[^/]+\/compare$/.test(path) && req.query.includeAi === 'true';
  if (ctx.accessMode === 'read_only') {
    if (req.method === 'GET' && !aiComparison) return next();
    if (path === '/notifications/mark-read') return next();
    return next(
      new ForbiddenError(
        'SUBSCRIPTION_READ_ONLY',
        'Renew your subscription; existing data can be read/exported',
      ),
    );
  }
  let feature: Feature | undefined;
  if (path.startsWith('/inventory/')) feature = 'core_inventory';
  if (path.startsWith('/suppliers') || path.startsWith('/quotations')) feature = 'core_suppliers';
  if (path.startsWith('/purchase-orders')) feature = 'core_po';
  if (path.startsWith('/ai/')) feature = 'ai_forecast';
  if (path.startsWith('/reports/'))
    feature = /\/(abc-analysis|eoq|cash-flow-projection|budget|weekly-digest)$/.test(path)
      ? 'advanced_reports'
      : 'basic_reports';
  if (aiComparison) feature = 'ai_forecast';
  if (feature && !ctx.features.has(feature))
    return next(
      new ForbiddenError('PLAN_FEATURE_UNAVAILABLE', `Your plan does not include ${feature}`, {
        feature,
      }),
    );
  next();
};
