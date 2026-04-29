import { z } from 'zod';

import { ROLES } from '../../shared/auth/types.js';

const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters');

const emailSchema = z.string().email().toLowerCase().max(254);

// ----- Registration (factory + owner) -----
export const RegisterFactoryRequestSchema = z.object({
  factory: z.object({
    name: z.string().min(2).max(200),
    businessType: z.enum(['rmg', 'textile', 'leather', 'light_manufacturing', 'other']),
    country: z.literal('BD').default('BD'),
    timeZone: z.string().default('Asia/Dhaka'),
  }),
  owner: z.object({
    fullName: z.string().min(2).max(120),
    email: emailSchema,
    password: passwordSchema,
  }),
});
export type RegisterFactoryRequest = z.infer<typeof RegisterFactoryRequestSchema>;

// ----- Login -----
export const LoginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

// ----- Refresh -----
export const RefreshRequestSchema = z.object({}).passthrough();

// ----- Password reset -----
export const ForgotPasswordRequestSchema = z.object({
  email: emailSchema,
});
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

export const ResetPasswordRequestSchema = z.object({
  token: z.string().min(16).max(256),
  newPassword: passwordSchema,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

// ----- Email verification -----
export const VerifyEmailRequestSchema = z.object({
  token: z.string().min(16).max(256),
});
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;

// ----- Change password (authenticated) -----
export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

// ----- User invitation -----
export const InviteUserRequestSchema = z.object({
  email: emailSchema,
  fullName: z.string().min(2).max(120),
  role: z.enum(ROLES as unknown as [string, ...string[]]),
});
export type InviteUserRequest = z.infer<typeof InviteUserRequestSchema>;

// ----- Responses -----
export const UserViewSchema = z.object({
  id: z.string(),
  factoryId: z.string(),
  email: z.string(),
  fullName: z.string(),
  role: z.string(),
  status: z.string(),
  emailVerified: z.boolean(),
});
export type UserView = z.infer<typeof UserViewSchema>;

export const FactoryViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  businessType: z.string(),
  timeZone: z.string(),
  baseCurrency: z.string(),
  status: z.string(),
});
export type FactoryView = z.infer<typeof FactoryViewSchema>;

export interface AuthLoginResponse {
  accessToken: string;
  accessTokenExpiresAt: string;
  user: UserView;
  factory: FactoryView;
}

export interface AuthRefreshResponse {
  accessToken: string;
  accessTokenExpiresAt: string;
}
