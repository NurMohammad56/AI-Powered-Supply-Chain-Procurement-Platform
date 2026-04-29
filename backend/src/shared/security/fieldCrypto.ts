import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';

import { env } from '../../config/env.js';

/**
 * AES-256-GCM helpers for field-level encryption of sensitive
 * tenant-scoped data (supplier tax IDs, bank details, payment-method
 * fingerprints). Use only at the persistence boundary: encrypt right
 * before write, decrypt right after read. NEVER persist plaintext in
 * audit logs - the audit redactor already strips known sensitive keys
 * but field crypto is the durable safety net.
 *
 * Wire format (base64 of binary): `[1B version][12B IV][16B tag][N ciphertext]`
 *   - version 0x01 = AES-256-GCM with the *current* key
 *   - version 0x02 = AES-256-GCM with a `kid`-prefixed previous key
 * Tag is appended (not prepended) per Node's GCM API; we keep it before
 * ciphertext on wire to match common envelope formats.
 *
 * Key rotation:
 *   - Set `FIELD_ENCRYPTION_KEY` to the new active key.
 *   - Append the old key to `FIELD_ENCRYPTION_KEY_PREVIOUS` as
 *     `kid1:<base64>` (comma-separated to chain multiple rotations).
 *   - Old ciphertexts continue to decrypt; new writes use the active key.
 *   - A background re-encryption job can rewrite stale rows offline.
 */

const ALGO = 'aes-256-gcm' as const;
const IV_BYTES = 12; // 96-bit IV per NIST SP 800-38D
const TAG_BYTES = 16;
const VERSION_CURRENT = 0x01;
const VERSION_PREVIOUS = 0x02;

interface KeyEntry {
  kid: string;
  key: Buffer;
}

let cachedActive: KeyEntry | null = null;
let cachedPrevious: ReadonlyArray<KeyEntry> | null = null;

function decodeKey(raw: string): Buffer {
  if (!raw) throw new Error('Field encryption key not configured');
  // Accept base64 (44 chars) or hex (64 chars).
  if (/^[a-fA-F0-9]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('FIELD_ENCRYPTION_KEY must decode to 32 bytes (AES-256)');
  }
  return buf;
}

function getActiveKey(): KeyEntry {
  if (cachedActive) return cachedActive;
  cachedActive = { kid: 'k0', key: decodeKey(env.FIELD_ENCRYPTION_KEY) };
  return cachedActive;
}

function getPreviousKeys(): ReadonlyArray<KeyEntry> {
  if (cachedPrevious) return cachedPrevious;
  if (!env.FIELD_ENCRYPTION_KEY_PREVIOUS) {
    cachedPrevious = [];
    return cachedPrevious;
  }
  const entries = env.FIELD_ENCRYPTION_KEY_PREVIOUS.split(',').map((s) => s.trim()).filter(Boolean);
  cachedPrevious = entries.map((entry) => {
    const [kid, value] = entry.split(':', 2);
    if (!kid || !value) throw new Error(`Invalid FIELD_ENCRYPTION_KEY_PREVIOUS entry: ${entry}`);
    return { kid, key: decodeKey(value) };
  });
  return cachedPrevious;
}

/** Encrypt a UTF-8 plaintext. Returns base64 of the wire envelope. */
export function encryptField(plaintext: string): string {
  if (plaintext.length === 0) return '';
  const { key } = getActiveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher: CipherGCM = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = Buffer.concat([Buffer.from([VERSION_CURRENT]), iv, tag, ct]);
  return envelope.toString('base64');
}

/**
 * Decrypt a previously-encrypted base64 envelope. Tries the active key
 * first; falls back to the previous-key list. Throws on tampering or
 * unknown version.
 */
export function decryptField(envelopeB64: string): string {
  if (envelopeB64.length === 0) return '';
  const buf = Buffer.from(envelopeB64, 'base64');
  if (buf.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new Error('Field envelope too short');
  }
  const version = buf[0];
  if (version !== VERSION_CURRENT && version !== VERSION_PREVIOUS) {
    throw new Error(`Unknown field-crypto version: ${version}`);
  }
  const iv = buf.subarray(1, 1 + IV_BYTES);
  const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(1 + IV_BYTES + TAG_BYTES);
  const candidates: KeyEntry[] = [getActiveKey(), ...getPreviousKeys()];
  let lastErr: unknown = null;
  for (const k of candidates) {
    try {
      const decipher: DecipherGCM = createDecipheriv(ALGO, k.key, iv);
      decipher.setAuthTag(tag);
      const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
      return pt.toString('utf8');
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`Field decryption failed across all keys: ${String(lastErr)}`);
}

/**
 * Detect whether a value already looks like a field envelope. Used in
 * Mongoose pre-save hooks so a partial update does not double-encrypt.
 */
export function isEncryptedEnvelope(value: string): boolean {
  if (!value) return false;
  try {
    const buf = Buffer.from(value, 'base64');
    if (buf.length < 1 + IV_BYTES + TAG_BYTES) return false;
    const v = buf[0];
    return v === VERSION_CURRENT || v === VERSION_PREVIOUS;
  } catch {
    return false;
  }
}

/**
 * Test-only key reset. The cache is module-level for performance; tests
 * mutating env vars need this to take effect.
 */
export function _resetCryptoCacheForTests(): void {
  cachedActive = null;
  cachedPrevious = null;
}
