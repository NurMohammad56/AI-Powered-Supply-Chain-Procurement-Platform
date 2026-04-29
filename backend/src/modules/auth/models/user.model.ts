import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';
import { auditPlugin } from '../../../shared/db/auditPlugin.js';
import type { Role } from '../../../shared/auth/types.js';

export type UserStatus = 'invited' | 'active' | 'disabled';

export interface NotificationChannelPrefs {
  email: boolean;
  inApp: boolean;
}
export interface NotificationPrefs {
  lowStock: NotificationChannelPrefs;
  poStatus: NotificationChannelPrefs;
  deliveryReminder: NotificationChannelPrefs;
  weeklyDigest: NotificationChannelPrefs;
}

export interface UserDoc {
  _id: Types.ObjectId;
  factoryId: Types.ObjectId;
  email: string;
  passwordHash: string;
  fullName: string;
  role: Role;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  emailVerifyToken: string | null;
  emailVerifyTokenExpiresAt: Date | null;
  passwordResetTokenHash: string | null;
  passwordResetExpiresAt: Date | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  notificationPrefs: NotificationPrefs;
  createdAt: Date;
  updatedAt: Date;
}

export type UserHydrated = HydratedDocument<UserDoc>;

const channelPrefSchema = new Schema<NotificationChannelPrefs>(
  {
    email: { type: Boolean, default: true },
    inApp: { type: Boolean, default: true },
  },
  { _id: false },
);

const userSchema = new Schema<UserDoc>(
  {
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    passwordHash: { type: String, required: true, select: false },
    fullName: { type: String, required: true, trim: true, maxlength: 120 },
    role: {
      type: String,
      enum: ['owner', 'manager', 'warehouse_staff', 'viewer'],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['invited', 'active', 'disabled'],
      default: 'active',
      index: true,
    },
    emailVerifiedAt: { type: Date, default: null },
    emailVerifyToken: { type: String, default: null, select: false },
    emailVerifyTokenExpiresAt: { type: Date, default: null, select: false },
    passwordResetTokenHash: { type: String, default: null, select: false },
    passwordResetExpiresAt: { type: Date, default: null, select: false },
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    notificationPrefs: {
      lowStock: { type: channelPrefSchema, default: () => ({ email: true, inApp: true }) },
      poStatus: { type: channelPrefSchema, default: () => ({ email: true, inApp: true }) },
      deliveryReminder: { type: channelPrefSchema, default: () => ({ email: true, inApp: true }) },
      weeklyDigest: { type: channelPrefSchema, default: () => ({ email: true, inApp: true }) },
    },
  },
  { timestamps: true },
);

userSchema.index({ factoryId: 1, email: 1 }, { unique: true });
userSchema.index({ factoryId: 1, role: 1 });

userSchema.plugin(tenancyPlugin);
userSchema.plugin(auditPlugin);

export const User = model<UserDoc>('User', userSchema);
