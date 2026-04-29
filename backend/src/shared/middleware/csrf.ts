import type { RequestHandler } from 'express';

import { ForbiddenError } from '../errors/HttpErrors.js';
import { ErrorCodes } from '../errors/errorCodes.js';

/**
 * Lightweight CSRF defence for cookie-authenticated endpoints.
 *
 * The refresh-token cookie is `httpOnly Secure SameSite=Lax`. SameSite=Lax
 * blocks most cross-site form submissions, but for double-defence we
 * additionally require a custom `X-CSRF` header that a cross-site form
 * cannot produce. The SPA sets this header on every refresh call from the
 * authenticated bootstrap (SDD §9.2).
 */
export const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  const value = req.header('x-csrf');
  if (!value || value.length < 8) {
    return next(new ForbiddenError(ErrorCodes.AUTH_CSRF_HEADER_MISSING, 'CSRF header missing'));
  }
  next();
};
