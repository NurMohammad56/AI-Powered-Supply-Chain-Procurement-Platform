import { Router } from 'express';

import { validate } from '../../shared/middleware/validate.js';
import { resolveTenant, tenantScope } from '../../shared/middleware/tenant.js';
import { rbacFor } from '../../shared/middleware/rbac.js';
import { requireCsrfHeader } from '../../shared/middleware/csrf.js';
import {
  rateLimitLogin,
  rateLimitRefresh,
  rateLimitUnauthenticated,
} from '../../shared/middleware/rateLimit.js';
import {
  ChangePasswordRequestSchema,
  ForgotPasswordRequestSchema,
  InviteUserRequestSchema,
  ListUsersQuerySchema,
  LoginRequestSchema,
  RegisterFactoryRequestSchema,
  ResetPasswordRequestSchema,
  UpdateMyProfileRequestSchema,
  UpdateUserRoleRequestSchema,
  UserIdParamSchema,
  VerifyEmailRequestSchema,
} from './auth.dto.js';
import { authController } from './auth.controller.js';

/**
 * Public auth router. Mounted at `/api/v1/auth` on the unauthenticated
 * router (no resolveTenant on these endpoints).
 */
export const authPublicRouter = Router();

authPublicRouter.post(
  '/register',
  rateLimitUnauthenticated,
  validate(RegisterFactoryRequestSchema),
  authController.register,
);

authPublicRouter.post(
  '/login',
  rateLimitLogin,
  validate(LoginRequestSchema),
  authController.login,
);

authPublicRouter.post('/refresh', rateLimitRefresh, requireCsrfHeader, authController.refresh);

authPublicRouter.post('/logout', authController.logout);

authPublicRouter.post(
  '/forgot-password',
  rateLimitUnauthenticated,
  validate(ForgotPasswordRequestSchema),
  authController.forgotPassword,
);

authPublicRouter.post(
  '/reset-password',
  rateLimitUnauthenticated,
  validate(ResetPasswordRequestSchema),
  authController.resetPassword,
);

authPublicRouter.post(
  '/verify-email',
  rateLimitUnauthenticated,
  validate(VerifyEmailRequestSchema),
  authController.verifyEmail,
);

/**
 * Authenticated auth router. Mounted at `/api/v1/auth` on the
 * authenticated router (resolveTenant + tenantScope applied at mount).
 */
export const authPrivateRouter = Router();

authPrivateRouter.get('/me', authController.me);

authPrivateRouter.patch(
  '/me',
  validate(UpdateMyProfileRequestSchema),
  authController.updateMyProfile,
);

authPrivateRouter.post(
  '/change-password',
  validate(ChangePasswordRequestSchema),
  authController.changePassword,
);

authPrivateRouter.get(
  '/users',
  rbacFor('user.invite'),
  validate(ListUsersQuerySchema, 'query'),
  authController.listUsers,
);

authPrivateRouter.post(
  '/invite',
  rbacFor('user.invite'),
  validate(InviteUserRequestSchema),
  authController.inviteUser,
);

authPrivateRouter.patch(
  '/users/:userId/role',
  rbacFor('user.role.assign'),
  validate(UserIdParamSchema, 'params'),
  validate(UpdateUserRoleRequestSchema),
  authController.updateUserRole,
);

authPrivateRouter.delete(
  '/users/:userId',
  rbacFor('user.role.assign'),
  validate(UserIdParamSchema, 'params'),
  authController.disableUser,
);

authPrivateRouter.post('/logout-everywhere', authController.logoutEverywhere);

// Re-export the middleware so the routes file can compose mountings cleanly.
export const authPrivateMiddleware = [resolveTenant, tenantScope] as const;
