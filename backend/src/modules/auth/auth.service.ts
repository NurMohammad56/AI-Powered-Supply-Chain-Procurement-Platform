import crypto from 'node:crypto';

import { Types } from 'mongoose';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import {
  ConflictError,
  ForbiddenError,
  UnauthorizedError,
  ValidationError,
} from '../../shared/errors/HttpErrors.js';
import { ErrorCodes } from '../../shared/errors/errorCodes.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../../shared/auth/password.js';
import {
  issueAccessToken,
  issueRefreshToken,
  newSessionFamily,
  sha256,
  verifyRefreshToken,
} from '../../shared/auth/jwt.js';
import { enqueueEmail } from '../../shared/queue/queues.js';
import type { Role, SubscriptionTier } from '../../shared/auth/types.js';
import { authRepository } from './auth.repository.js';
import type { FactoryDoc } from './models/factory.model.js';
import type { UserDoc } from './models/user.model.js';
import type {
  AuthLoginResponse,
  AuthRefreshResponse,
  ForgotPasswordRequest,
  LoginRequest,
  RegisterFactoryRequest,
  ResetPasswordRequest,
  UserView,
  FactoryView,
  VerifyEmailRequest,
  ChangePasswordRequest,
  InviteUserRequest,
} from './auth.dto.js';

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ACCOUNT_LOCK_AFTER_FAILS = 5;
const ACCOUNT_LOCK_DURATION_MS = 15 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IssuedTokenPair {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface LoginResult extends AuthLoginResponse {
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

interface ClientMeta {
  userAgent?: string | null;
  ip?: string | null;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function toUserView(user: UserDoc): UserView {
  return {
    id: user._id.toString(),
    factoryId: user.factoryId.toString(),
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    status: user.status,
    emailVerified: user.emailVerifiedAt !== null,
  };
}

function toFactoryView(f: FactoryDoc): FactoryView {
  return {
    id: f._id.toString(),
    name: f.name,
    slug: f.slug,
    businessType: f.businessType,
    timeZone: f.timeZone,
    baseCurrency: f.baseCurrency,
    status: f.status,
  };
}

export class AuthService {
  /**
   * Register a new factory + owner user. Provisions a 14-day Growth-tier
   * trial subscription (FR-BIL-01) - the subscription record itself lands
   * in the billing module; for now we set factory.status = 'trial'.
   *
   * Tier inference for JWT claims is `trial` until the billing module
   * upgrades it.
   */
  async registerFactory(input: RegisterFactoryRequest): Promise<{
    factory: FactoryView;
    owner: UserView;
  }> {
    const policy = checkPasswordPolicy(input.owner.password);
    if (!policy.ok) {
      throw new ValidationError({ password: policy.message }, policy.message);
    }

    const baseSlug = slugify(input.factory.name) || `factory-${Date.now()}`;
    let slug = baseSlug;
    let attempt = 0;
    while (await authRepository.findFactoryBySlug(slug)) {
      attempt += 1;
      slug = `${baseSlug}-${attempt}`;
      if (attempt > 100) {
        throw new ConflictError(ErrorCodes.RESOURCE_DUPLICATE, 'Could not allocate factory slug');
      }
    }

    const factory = await authRepository.createFactory({
      name: input.factory.name,
      slug,
      businessType: input.factory.businessType,
      country: 'BD',
      timeZone: input.factory.timeZone,
      baseCurrency: 'BDT',
      branding: { logoUrl: null, primaryColor: '#1E40AF' },
      ownerUserId: null,
      status: 'trial',
    });

    const passwordHash = await hashPassword(input.owner.password);
    const verifyToken = crypto.randomBytes(32).toString('base64url');

    const owner = await authRepository.withScope(factory._id, () =>
      authRepository.createUser({
        factoryId: factory._id,
        email: input.owner.email,
        passwordHash,
        fullName: input.owner.fullName,
        role: 'owner',
        status: 'active',
        emailVerifiedAt: null,
        emailVerifyToken: verifyToken,
        emailVerifyTokenExpiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
        notificationPrefs: {
          lowStock: { email: true, inApp: true },
          poStatus: { email: true, inApp: true },
          deliveryReminder: { email: true, inApp: true },
          weeklyDigest: { email: true, inApp: true },
        },
      }),
    );

    await authRepository.updateFactory(factory._id, { ownerUserId: owner._id });

    await enqueueEmail('email.send', {
      factoryId: factory._id.toString(),
      to: owner.email,
      subject: 'Verify your email - SCP Platform',
      html: this.renderVerifyEmail(owner.fullName, verifyToken),
      template: 'auth.verify_email',
    }).catch((err: unknown) =>
      logger.warn({ err, event: 'email.enqueue_failed', userId: owner._id.toString() }, 'verify email enqueue failed'),
    );

    return {
      factory: toFactoryView({ ...factory, ownerUserId: owner._id }),
      owner: toUserView(owner),
    };
  }

  /**
   * Authenticate a user. Account lockout (FR-AUTH-09) after 5 failed
   * attempts within the lock window.
   */
  async login(input: LoginRequest, meta: ClientMeta): Promise<LoginResult> {
    // The user lookup must run inside a tenant scope. Since we do not yet
    // know the tenant, we scope to a sentinel and broaden the find via a
    // direct Mongoose call that bypasses the plugin filter at the model
    // level. The repository's `findUserForLoginByEmail` uses a global
    // lookup pattern via direct query.
    const candidate = await this.findGlobalUserByEmail(input.email);
    if (!candidate) {
      throw new UnauthorizedError(ErrorCodes.AUTH_INVALID_CREDENTIALS, 'Invalid credentials');
    }

    if (candidate.status === 'disabled') {
      throw new ForbiddenError(ErrorCodes.AUTH_ACCOUNT_DISABLED, 'Account disabled');
    }

    if (candidate.lockedUntil && candidate.lockedUntil.getTime() > Date.now()) {
      throw new ForbiddenError(ErrorCodes.AUTH_ACCOUNT_LOCKED, 'Account temporarily locked', {
        lockedUntil: candidate.lockedUntil.toISOString(),
      });
    }

    const passwordOk = await verifyPassword(input.password, candidate.passwordHash);
    if (!passwordOk) {
      const fails = candidate.failedLoginCount + 1;
      const lockUntil =
        fails >= ACCOUNT_LOCK_AFTER_FAILS
          ? new Date(Date.now() + ACCOUNT_LOCK_DURATION_MS)
          : null;
      await authRepository.withScope(candidate.factoryId, () =>
        authRepository.incrementFailedLogins(candidate._id, lockUntil),
      );
      throw new UnauthorizedError(ErrorCodes.AUTH_INVALID_CREDENTIALS, 'Invalid credentials');
    }

    if (candidate.failedLoginCount > 0 || candidate.lockedUntil) {
      await authRepository.withScope(candidate.factoryId, () =>
        authRepository.resetFailedLogins(candidate._id),
      );
    }

    const factory = await authRepository.findFactoryById(candidate.factoryId);
    if (!factory) {
      throw new UnauthorizedError(ErrorCodes.AUTH_INVALID_CREDENTIALS, 'Tenant not found');
    }
    if (factory.status === 'suspended' || factory.status === 'cancelled') {
      throw new ForbiddenError(ErrorCodes.AUTH_ACCOUNT_DISABLED, 'Tenant access suspended');
    }

    const tokens = await this.issueTokenPair({
      userId: candidate._id,
      factoryId: candidate.factoryId,
      role: candidate.role,
      tier: this.tierFromFactoryStatus(factory.status),
      family: newSessionFamily(),
      meta,
    });

    return {
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
      user: toUserView(candidate),
      factory: toFactoryView(factory),
    };
  }

  /**
   * Rotate refresh token. Family-based reuse detection (SDD §9.1.1):
   * if a token is presented that has already been rotated, the entire
   * session family is invalidated immediately.
   */
  async refresh(rawToken: string, meta: ClientMeta): Promise<{ tokens: AuthRefreshResponse; refreshToken: string; refreshTokenExpiresAt: string }> {
    const claims = verifyRefreshToken(rawToken);
    const factoryId = new Types.ObjectId(claims.factoryId);

    return authRepository.withScope(factoryId, async () => {
      const tokenHash = sha256(rawToken);
      const session = await authRepository.findActiveSessionByTokenHash(tokenHash);

      if (!session) {
        // Signature was valid but the token is not in our active set - reuse.
        const revoked = await authRepository.revokeFamily(claims.family, 'reuse_detected');
        logger.warn(
          {
            event: 'AUTH_REFRESH_REUSE_DETECTED',
            family: claims.family,
            userId: claims.sub,
            revoked,
          },
          'refresh token reuse detected; family invalidated',
        );
        throw new UnauthorizedError(
          ErrorCodes.AUTH_REFRESH_REUSE_DETECTED,
          'Refresh token reuse detected; please re-authenticate',
        );
      }

      // Rotate: revoke this token and issue the next in the family.
      await authRepository.revokeSession(session._id, 'rotation');

      const user = await authRepository.findUserById(session.userId);
      if (!user || user.status !== 'active') {
        throw new UnauthorizedError(ErrorCodes.AUTH_REFRESH_INVALID, 'User no longer active');
      }
      const factory = await authRepository.findFactoryById(factoryId);
      if (!factory || factory.status === 'suspended' || factory.status === 'cancelled') {
        throw new UnauthorizedError(ErrorCodes.AUTH_REFRESH_INVALID, 'Tenant inactive');
      }

      const tokens = await this.issueTokenPair({
        userId: user._id,
        factoryId,
        role: user.role,
        tier: this.tierFromFactoryStatus(factory.status),
        family: session.family,
        meta,
      });

      return {
        tokens: {
          accessToken: tokens.accessToken,
          accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
        },
        refreshToken: tokens.refreshToken,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
      };
    });
  }

  async logout(rawToken: string | null): Promise<void> {
    if (!rawToken) return;
    let claims;
    try {
      claims = verifyRefreshToken(rawToken);
    } catch {
      return;
    }
    const factoryId = new Types.ObjectId(claims.factoryId);
    await authRepository.withScope(factoryId, async () => {
      const tokenHash = sha256(rawToken);
      const session = await authRepository.findActiveSessionByTokenHash(tokenHash);
      if (session) {
        await authRepository.revokeSession(session._id, 'logout');
      }
    });
  }

  async logoutEverywhere(userId: Types.ObjectId, factoryId: Types.ObjectId): Promise<void> {
    await authRepository.withScope(factoryId, async () => {
      const user = await authRepository.findUserById(userId);
      if (!user) return;
      // No family; revoke every active session of this user.
      // We do this via the session model directly; the repository exposes
      // a family-revocation primitive but here we revoke all of the user's
      // active sessions regardless of family.
      const { Session } = await import('./models/session.model.js');
      await Session.updateMany(
        { userId, revokedAt: null },
        { $set: { revokedAt: new Date(), revokeReason: 'logout' } },
      ).exec();
    });
  }

  async forgotPassword(input: ForgotPasswordRequest): Promise<void> {
    const user = await this.findGlobalUserByEmail(input.email);
    // Intentionally always succeed silently to avoid email enumeration.
    if (!user || user.status !== 'active') return;

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = sha256(rawToken);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

    await authRepository.withScope(user.factoryId, () =>
      authRepository.updateUser(user._id, {
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: expiresAt,
      }),
    );

    await enqueueEmail('email.send', {
      factoryId: user.factoryId.toString(),
      to: user.email,
      subject: 'Reset your SCP Platform password',
      html: this.renderResetEmail(user.fullName, rawToken),
      template: 'auth.password_reset',
    }).catch((err: unknown) =>
      logger.warn({ err, event: 'email.enqueue_failed' }, 'reset email enqueue failed'),
    );
  }

  async resetPassword(input: ResetPasswordRequest): Promise<void> {
    const policy = checkPasswordPolicy(input.newPassword);
    if (!policy.ok) {
      throw new ValidationError({ newPassword: policy.message }, policy.message);
    }
    const tokenHash = sha256(input.token);
    const { User } = await import('./models/user.model.js');

    // Look up user by reset-token hash globally (no tenant scope yet known).
    // Use a raw model call wrapped in a sentinel scope so the tenancy plugin
    // does not block; then re-query inside the user's tenant scope.
    const stub = await User.collection.findOne({ passwordResetTokenHash: tokenHash });
    if (!stub) {
      throw new UnauthorizedError(ErrorCodes.AUTH_RESET_TOKEN_INVALID, 'Reset token invalid');
    }
    const userId = stub._id;
    const factoryId = stub.factoryId;

    await authRepository.withScope(factoryId, async () => {
      const user = await authRepository.findUserById(userId);
      if (
        !user ||
        !user.passwordResetExpiresAt ||
        user.passwordResetExpiresAt.getTime() < Date.now()
      ) {
        throw new UnauthorizedError(ErrorCodes.AUTH_RESET_TOKEN_INVALID, 'Reset token expired');
      }
      const passwordHash = await hashPassword(input.newPassword);
      await authRepository.updateUser(user._id, {
        passwordHash,
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
      });
      // Invalidate all active sessions of this user.
      const { Session } = await import('./models/session.model.js');
      await Session.updateMany(
        { userId: user._id, revokedAt: null },
        { $set: { revokedAt: new Date(), revokeReason: 'admin' } },
      ).exec();
    });
  }

  async verifyEmail(input: VerifyEmailRequest): Promise<void> {
    const { User } = await import('./models/user.model.js');
    const stub = await User.collection.findOne({ emailVerifyToken: input.token });
    if (!stub) {
      throw new UnauthorizedError(ErrorCodes.AUTH_VERIFY_TOKEN_INVALID, 'Verification token invalid');
    }
    const expires = stub.emailVerifyTokenExpiresAt as Date | null;
    if (!expires || expires.getTime() < Date.now()) {
      throw new UnauthorizedError(ErrorCodes.AUTH_VERIFY_TOKEN_INVALID, 'Verification token expired');
    }
    const userId = stub._id;
    const factoryId = stub.factoryId;
    await authRepository.withScope(factoryId, () =>
      authRepository.updateUser(userId, {
        emailVerifiedAt: new Date(),
        emailVerifyToken: null,
        emailVerifyTokenExpiresAt: null,
      }),
    );
  }

  async changePassword(
    userId: Types.ObjectId,
    factoryId: Types.ObjectId,
    input: ChangePasswordRequest,
  ): Promise<void> {
    const policy = checkPasswordPolicy(input.newPassword);
    if (!policy.ok) {
      throw new ValidationError({ newPassword: policy.message }, policy.message);
    }
    await authRepository.withScope(factoryId, async () => {
      const { User } = await import('./models/user.model.js');
      const userWithHash = await User.findById(userId)
        .select('+passwordHash')
        .lean<UserDoc & { passwordHash: string }>()
        .exec();
      if (!userWithHash) {
        throw new UnauthorizedError(ErrorCodes.AUTH_INVALID_CREDENTIALS);
      }
      const currentOk = await verifyPassword(input.currentPassword, userWithHash.passwordHash);
      if (!currentOk) {
        throw new UnauthorizedError(ErrorCodes.AUTH_INVALID_CREDENTIALS, 'Current password incorrect');
      }
      const passwordHash = await hashPassword(input.newPassword);
      await authRepository.updateUser(userId, { passwordHash });
    });
  }

  async inviteUser(
    actorUserId: Types.ObjectId,
    actorRole: Role,
    factoryId: Types.ObjectId,
    input: InviteUserRequest,
  ): Promise<UserView> {
    const { assignableRolesBy } = await import('../../shared/auth/rbac.js');
    const allowed = assignableRolesBy(actorRole);
    if (!allowed.includes(input.role as Role)) {
      throw new ForbiddenError(
        ErrorCodes.RBAC_CAPABILITY_DENIED,
        `Role ${actorRole} cannot assign role ${input.role}`,
      );
    }

    return authRepository.withScope(factoryId, async () => {
      const existing = await authRepository.withScope(factoryId, async () => {
        const { User } = await import('./models/user.model.js');
        return User.findOne({ email: input.email }).lean<UserDoc>().exec();
      });
      if (existing) {
        throw new ConflictError(ErrorCodes.RESOURCE_DUPLICATE, 'User with that email already exists');
      }
      const tempPassword = crypto.randomBytes(24).toString('base64url') + 'A1!';
      const passwordHash = await hashPassword(tempPassword);
      const verifyToken = crypto.randomBytes(32).toString('base64url');
      const created = await authRepository.createUser({
        factoryId,
        email: input.email,
        passwordHash,
        fullName: input.fullName,
        role: input.role as Role,
        status: 'invited',
        emailVerifiedAt: null,
        emailVerifyToken: verifyToken,
        emailVerifyTokenExpiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
        notificationPrefs: {
          lowStock: { email: true, inApp: true },
          poStatus: { email: true, inApp: true },
          deliveryReminder: { email: true, inApp: true },
          weeklyDigest: { email: true, inApp: true },
        },
      });

      await enqueueEmail('email.send', {
        factoryId: factoryId.toString(),
        to: created.email,
        subject: 'You have been invited to SCP Platform',
        html: this.renderInviteEmail(created.fullName, verifyToken, actorUserId.toString()),
        template: 'auth.invite',
      }).catch((err: unknown) =>
        logger.warn({ err, event: 'email.enqueue_failed' }, 'invite email enqueue failed'),
      );

      return toUserView(created);
    });
  }

  // ---------- internals ----------

  private async issueTokenPair(args: {
    userId: Types.ObjectId;
    factoryId: Types.ObjectId;
    role: Role;
    tier: SubscriptionTier;
    family: string;
    meta: ClientMeta;
  }): Promise<IssuedTokenPair> {
    const access = issueAccessToken({
      userId: args.userId,
      factoryId: args.factoryId,
      role: args.role,
      tier: args.tier,
      seats: 0,
      features: [],
    });
    const refresh = issueRefreshToken({
      userId: args.userId,
      factoryId: args.factoryId,
      family: args.family,
    });

    await authRepository.withScope(args.factoryId, () =>
      authRepository.createSession({
        factoryId: args.factoryId,
        userId: args.userId,
        refreshTokenHash: sha256(refresh.token),
        family: args.family,
        jti: refresh.jti,
        userAgent: args.meta.userAgent ?? null,
        ip: args.meta.ip ?? null,
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        revokedAt: null,
        revokeReason: null,
      }),
    );

    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt,
    };
  }

  private tierFromFactoryStatus(status: FactoryDoc['status']): SubscriptionTier {
    return status === 'trial' ? 'trial' : 'starter';
  }

  /**
   * Cross-tenant lookup helper. Login and forgot-password flows must look
   * up a user by email before any tenant context exists. We bypass the
   * tenancy plugin by using `Model.collection` (the raw driver collection),
   * which does not run plugin hooks. This is the SINGLE legitimate place
   * in the codebase where this bypass is acceptable.
   */
  private async findGlobalUserByEmail(
    email: string,
  ): Promise<(UserDoc & { passwordHash: string }) | null> {
    const { User } = await import('./models/user.model.js');
    const raw = await User.collection.findOne({ email });
    if (!raw) return null;
    return raw as unknown as UserDoc & { passwordHash: string };
  }

  private renderVerifyEmail(name: string, token: string): string {
    const url = `${env.FRONTEND_BASE_URL}/verify-email?token=${encodeURIComponent(token)}`;
    return `<p>Hi ${escapeHtml(name)},</p><p>Confirm your email: <a href="${url}">${url}</a></p><p>This link expires in 24 hours.</p>`;
  }

  private renderResetEmail(name: string, token: string): string {
    const url = `${env.FRONTEND_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
    return `<p>Hi ${escapeHtml(name)},</p><p>Reset your password: <a href="${url}">${url}</a></p><p>This link expires in 30 minutes.</p>`;
  }

  private renderInviteEmail(name: string, token: string, _inviterId: string): string {
    const url = `${env.FRONTEND_BASE_URL}/accept-invite?token=${encodeURIComponent(token)}`;
    return `<p>Hi ${escapeHtml(name)},</p><p>You have been invited to join the SCP Platform. Accept here: <a href="${url}">${url}</a></p>`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const authService = new AuthService();
