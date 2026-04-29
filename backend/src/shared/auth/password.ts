import bcrypt from 'bcrypt';

import { env } from '../../config/env.js';

/**
 * Strong password policy per FR-AUTH-08:
 *   - >= 10 chars
 *   - one uppercase, one lowercase, one digit, one symbol
 */
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{10,}$/u;

export interface PasswordPolicyError {
  ok: false;
  message: string;
}
export interface PasswordPolicyOk {
  ok: true;
}
export type PasswordPolicyResult = PasswordPolicyOk | PasswordPolicyError;

export function checkPasswordPolicy(plain: string): PasswordPolicyResult {
  if (typeof plain !== 'string') return { ok: false, message: 'Password must be a string' };
  if (plain.length < 10) return { ok: false, message: 'Password must be at least 10 characters' };
  if (plain.length > 128) return { ok: false, message: 'Password must be at most 128 characters' };
  if (!PASSWORD_REGEX.test(plain)) {
    return {
      ok: false,
      message:
        'Password must contain uppercase, lowercase, digit, and symbol characters',
    };
  }
  return { ok: true };
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, env.BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
