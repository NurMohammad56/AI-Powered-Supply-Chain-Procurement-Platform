/**
 * Public surface of the auth module. Cross-module imports must come
 * through this barrel only - the eslint-plugin-boundaries config
 * forbids reaching into module internals from any other module.
 */

export {
  authPublicRouter,
  authPrivateRouter,
  authPrivateMiddleware,
} from './auth.routes.js';

export {
  RegisterFactoryRequestSchema,
  LoginRequestSchema,
  ForgotPasswordRequestSchema,
  ResetPasswordRequestSchema,
  VerifyEmailRequestSchema,
  ChangePasswordRequestSchema,
  InviteUserRequestSchema,
  type RegisterFactoryRequest,
  type LoginRequest,
  type ForgotPasswordRequest,
  type ResetPasswordRequest,
  type VerifyEmailRequest,
  type ChangePasswordRequest,
  type InviteUserRequest,
  type AuthLoginResponse,
  type AuthRefreshResponse,
  type UserView,
  type FactoryView,
} from './auth.dto.js';

export { Factory, type FactoryDoc, type FactoryStatus } from './models/factory.model.js';
export { User, type UserDoc, type UserStatus } from './models/user.model.js';
export { Session, type SessionDoc } from './models/session.model.js';
