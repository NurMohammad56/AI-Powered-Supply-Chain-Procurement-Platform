import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

import { tenancyPlugin } from '../../../shared/db/tenancyPlugin.js';

export type RevokeReason = 'logout' | 'rotation' | 'reuse_detected' | 'admin' | null;

export interface SessionDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  userId: Types.ObjectId;
  refreshTokenHash: string;
  family: string;
  jti: string;
  userAgent: string | null;
  ip: string | null;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokeReason: RevokeReason;
  createdAt: Date;
  updatedAt: Date;
}

export type SessionHydrated = HydratedDocument<SessionDoc>;

const sessionSchema = new Schema<SessionDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    refreshTokenHash: { type: String, required: true },
    family: { type: String, required: true },
    jti: { type: String, required: true },
    userAgent: { type: String, default: null, maxlength: 512 },
    ip: { type: String, default: null, maxlength: 64 },
    issuedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokeReason: {
      type: String,
      enum: ['logout', 'rotation', 'reuse_detected', 'admin', null],
      default: null,
    },
  },
  { timestamps: true },
);

sessionSchema.index({ refreshTokenHash: 1 }, { unique: true });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ tenantId: 1, userId: 1, revokedAt: 1 });
sessionSchema.index({ family: 1 });

sessionSchema.plugin(tenancyPlugin);

export const Session = model<SessionDoc>('Session', sessionSchema);
