import type { Request, Response } from 'express';

import { env } from '../../config/env.js';
import { asyncHandler } from '../../shared/http/asyncHandler.js';
import { ok, created, noContent } from '../../shared/http/apiResponse.js';
import { UnauthorizedError } from '../../shared/errors/HttpErrors.js';
import { ErrorCodes } from '../../shared/errors/errorCodes.js';
import type { TenantContext } from '../../shared/auth/types.js';
import { authService } from './auth.service.js';

function requireContext(req: Request): TenantContext {
  if (!req.context) {
    throw new UnauthorizedError(ErrorCodes.AUTH_TOKEN_MISSING, 'Tenant context not resolved');
  }
  return req.context;
}

const REFRESH_COOKIE = 'scp_refresh';
const CSRF_COOKIE = 'scp_csrf';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

function setRefreshCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    domain: env.COOKIE_DOMAIN || undefined,
    path: REFRESH_COOKIE_PATH,
    expires: expiresAt,
  });
  // CSRF double-submit cookie - readable by JS, paired with X-CSRF header.
  const csrf = generateCsrfValue();
  res.cookie(CSRF_COOKIE, csrf, {
    httpOnly: false,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    domain: env.COOKIE_DOMAIN || undefined,
    path: '/',
    expires: expiresAt,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    domain: env.COOKIE_DOMAIN || undefined,
    path: REFRESH_COOKIE_PATH,
  });
  res.clearCookie(CSRF_COOKIE, {
    httpOnly: false,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    domain: env.COOKIE_DOMAIN || undefined,
    path: '/',
  });
}

function generateCsrfValue(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
}

function clientMeta(req: Request): { userAgent: string | null; ip: string | null } {
  return {
    userAgent: req.header('user-agent') ?? null,
    ip: req.ip ?? null,
  };
}

export const authController = {
  register: asyncHandler(async (req, res) => {
    const result = await authService.registerFactory(req.body);
    return created(req, res, result);
  }),

  login: asyncHandler(async (req, res) => {
    const result = await authService.login(req.body, clientMeta(req));
    setRefreshCookie(res, result.refreshToken, new Date(result.refreshTokenExpiresAt));
    const { refreshToken: _r, refreshTokenExpiresAt: _e, ...response } = result;
    void _r;
    void _e;
    return ok(req, res, response);
  }),

  refresh: asyncHandler(async (req, res) => {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const raw = cookies[REFRESH_COOKIE];
    if (!raw) {
      throw new UnauthorizedError(ErrorCodes.AUTH_REFRESH_INVALID, 'Refresh token missing');
    }
    const result = await authService.refresh(raw, clientMeta(req));
    setRefreshCookie(res, result.refreshToken, new Date(result.refreshTokenExpiresAt));
    return ok(req, res, result.tokens);
  }),

  logout: asyncHandler(async (req, res) => {
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const raw = cookies[REFRESH_COOKIE] ?? null;
    await authService.logout(raw);
    clearRefreshCookie(res);
    return noContent(res);
  }),

  forgotPassword: asyncHandler(async (req, res) => {
    await authService.forgotPassword(req.body);
    return ok(req, res, { ok: true });
  }),

  resetPassword: asyncHandler(async (req, res) => {
    await authService.resetPassword(req.body);
    return ok(req, res, { ok: true });
  }),

  verifyEmail: asyncHandler(async (req, res) => {
    await authService.verifyEmail(req.body);
    return ok(req, res, { ok: true });
  }),

  me: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    return ok(req, res, {
      userId: ctx.userId.toString(),
      factoryId: ctx.factoryId.toString(),
      role: ctx.role,
      tier: ctx.subscriptionTier,
      features: Array.from(ctx.features),
    });
  }),

  changePassword: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    await authService.changePassword(ctx.userId, ctx.factoryId, req.body);
    return ok(req, res, { ok: true });
  }),

  inviteUser: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await authService.inviteUser(ctx.userId, ctx.role, ctx.factoryId, req.body);
    return created(req, res, result);
  }),

  logoutEverywhere: asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    await authService.logoutEverywhere(ctx.userId, ctx.factoryId);
    clearRefreshCookie(res);
    return noContent(res);
  }),
};
