import crypto from 'node:crypto';

import jwt, { type SignOptions, type JwtPayload } from 'jsonwebtoken';
import type { Types } from 'mongoose';

import { env } from '../../config/env.js';
import { UnauthorizedError } from '../errors/HttpErrors.js';
import { ErrorCodes } from '../errors/errorCodes.js';
import type { Role, SubscriptionTier } from './types.js';

export interface AccessTokenClaims extends JwtPayload {
  sub: string;
  tenantId: string;
  role: Role;
  tier: SubscriptionTier;
  seats: number;
  features: string[];
  jti: string;
}

export interface RefreshTokenClaims extends JwtPayload {
  sub: string;
  tenantId: string;
  family: string;
  jti: string;
}

export interface IssueAccessTokenInput {
  userId: Types.ObjectId | string;
  tenantId: Types.ObjectId | string;
  role: Role;
  tier: SubscriptionTier;
  seats: number;
  features?: string[];
}

export interface IssueRefreshTokenInput {
  userId: Types.ObjectId | string;
  tenantId: Types.ObjectId | string;
  family: string;
}

export interface IssuedToken {
  token: string;
  jti: string;
  expiresAt: Date;
}

const accessSignOptions: SignOptions = {
  algorithm: 'HS256',
  expiresIn: env.JWT_ACCESS_TTL as SignOptions['expiresIn'],
  issuer: env.JWT_ISSUER,
  audience: env.JWT_AUDIENCE,
};

const refreshSignOptions: SignOptions = {
  algorithm: 'HS256',
  expiresIn: env.JWT_REFRESH_TTL as SignOptions['expiresIn'],
  issuer: env.JWT_ISSUER,
  audience: env.JWT_AUDIENCE,
};

export function newJti(): string {
  return crypto.randomUUID();
}

export function newSessionFamily(): string {
  return crypto.randomUUID();
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function issueAccessToken(input: IssueAccessTokenInput): IssuedToken {
  const jti = newJti();
  const payload: Omit<AccessTokenClaims, 'iat' | 'exp' | 'iss' | 'aud'> = {
    sub: input.userId.toString(),
    tenantId: input.tenantId.toString(),
    role: input.role,
    tier: input.tier,
    seats: input.seats,
    features: input.features ?? [],
    jti,
  };
  const token = jwt.sign(payload, env.JWT_ACCESS_SECRET, accessSignOptions);
  const decoded = jwt.decode(token) as JwtPayload | null;
  const expSec = decoded?.exp ?? 0;
  return { token, jti, expiresAt: new Date(expSec * 1000) };
}

export function issueRefreshToken(input: IssueRefreshTokenInput): IssuedToken {
  const jti = newJti();
  const payload: Omit<RefreshTokenClaims, 'iat' | 'exp' | 'iss' | 'aud'> = {
    sub: input.userId.toString(),
    tenantId: input.tenantId.toString(),
    family: input.family,
    jti,
  };
  const token = jwt.sign(payload, env.JWT_REFRESH_SECRET, refreshSignOptions);
  const decoded = jwt.decode(token) as JwtPayload | null;
  const expSec = decoded?.exp ?? 0;
  return { token, jti, expiresAt: new Date(expSec * 1000) };
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const claims = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }) as AccessTokenClaims;
    return claims;
  } catch (err) {
    const isExpired = err instanceof jwt.TokenExpiredError;
    throw new UnauthorizedError(
      isExpired ? ErrorCodes.AUTH_TOKEN_EXPIRED : ErrorCodes.AUTH_TOKEN_INVALID,
      isExpired ? 'Access token expired' : 'Access token invalid',
    );
  }
}

export function verifyRefreshToken(token: string): RefreshTokenClaims {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET, {
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }) as RefreshTokenClaims;
  } catch {
    throw new UnauthorizedError(ErrorCodes.AUTH_REFRESH_INVALID, 'Refresh token invalid');
  }
}
