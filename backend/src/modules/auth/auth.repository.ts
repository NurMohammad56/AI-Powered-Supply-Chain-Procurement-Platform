import type { Types } from 'mongoose';

import { tenantStorage } from '../../shared/db/tenancyPlugin.js';
import { Factory, type FactoryDoc } from './models/factory.model.js';
import { User, type UserDoc } from './models/user.model.js';
import { Session, type SessionDoc } from './models/session.model.js';

/**
 * Repository for the auth module.
 *
 * `factories` is GLOBAL (the tenant root). Methods touching `Factory` run
 * outside the tenancy plugin scope; methods touching `User` and `Session`
 * must run inside `tenantStorage.run(...)`.
 *
 * The `bootstrapTenant` method is the single legitimate place where we
 * write to a tenant-scoped collection from outside an existing tenant
 * scope - it does so by establishing the scope itself.
 */
export class AuthRepository {
  // ----- Factories (global) -----

  async findFactoryById(id: Types.ObjectId | string): Promise<FactoryDoc | null> {
    return Factory.findById(id).lean<FactoryDoc>().exec();
  }

  async findFactoryBySlug(slug: string): Promise<FactoryDoc | null> {
    return Factory.findOne({ slug }).lean<FactoryDoc>().exec();
  }

  async createFactory(input: Omit<FactoryDoc, '_id' | 'createdAt' | 'updatedAt'>): Promise<FactoryDoc> {
    const doc = await Factory.create(input);
    return doc.toObject();
  }

  async updateFactory(
    id: Types.ObjectId,
    patch: Partial<FactoryDoc>,
  ): Promise<FactoryDoc | null> {
    return Factory.findByIdAndUpdate(id, patch, { new: true }).lean<FactoryDoc>().exec();
  }

  // ----- Users (tenant-scoped) -----

  async findUserById(id: Types.ObjectId | string): Promise<UserDoc | null> {
    return User.findById(id).lean<UserDoc>().exec();
  }

  async createUser(input: Omit<UserDoc, '_id' | 'createdAt' | 'updatedAt' | 'factoryId'> & {
    factoryId?: Types.ObjectId;
  }): Promise<UserDoc> {
    const doc = await User.create(input);
    return doc.toObject();
  }

  async updateUser(id: Types.ObjectId, patch: Partial<UserDoc>): Promise<UserDoc | null> {
    return User.findByIdAndUpdate(id, patch, { new: true }).lean<UserDoc>().exec();
  }

  async incrementFailedLogins(id: Types.ObjectId, lockUntil: Date | null): Promise<void> {
    await User.updateOne({ _id: id }, {
      $inc: { failedLoginCount: 1 },
      $set: lockUntil ? { lockedUntil: lockUntil } : {},
    }).exec();
  }

  async resetFailedLogins(id: Types.ObjectId): Promise<void> {
    await User.updateOne(
      { _id: id },
      { $set: { failedLoginCount: 0, lockedUntil: null } },
    ).exec();
  }

  // ----- Sessions (tenant-scoped) -----

  async createSession(input: Omit<SessionDoc, '_id' | 'createdAt' | 'updatedAt'>): Promise<SessionDoc> {
    const doc = await Session.create(input);
    return doc.toObject();
  }

  async findActiveSessionByTokenHash(hash: string): Promise<SessionDoc | null> {
    return Session.findOne({ refreshTokenHash: hash, revokedAt: null }).lean<SessionDoc>().exec();
  }

  async findSessionByJti(jti: string): Promise<SessionDoc | null> {
    return Session.findOne({ jti }).lean<SessionDoc>().exec();
  }

  async revokeSession(
    id: Types.ObjectId,
    reason: 'logout' | 'rotation' | 'reuse_detected' | 'admin',
  ): Promise<void> {
    await Session.updateOne(
      { _id: id },
      { $set: { revokedAt: new Date(), revokeReason: reason } },
    ).exec();
  }

  async revokeFamily(family: string, reason: 'reuse_detected' | 'admin' | 'logout'): Promise<number> {
    const result = await Session.updateMany(
      { family, revokedAt: null },
      { $set: { revokedAt: new Date(), revokeReason: reason } },
    ).exec();
    return result.modifiedCount ?? 0;
  }

  // ----- Helpers that establish a tenant scope on behalf of the caller -----

  /**
   * Run an operation under a freshly established tenant scope. Used by
   * the auth.service to perform login (which must look up the user
   * before the tenant context exists) and registration bootstrap.
   */
  withScope<T>(factoryId: Types.ObjectId, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      tenantStorage.run({ factoryId }, () => {
        fn().then(resolve, reject);
      });
    });
  }
}

export const authRepository = new AuthRepository();
