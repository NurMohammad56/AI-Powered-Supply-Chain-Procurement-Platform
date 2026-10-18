process.env.MONGO_URI ??= 'mongodb://localhost:27017/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= '12345678901234567890123456789012';
process.env.JWT_REFRESH_SECRET ??= '22345678901234567890123456789012';
import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import {
  encryptField,
  decryptField,
  isEncryptedEnvelope,
  _resetCryptoCacheForTests,
} from './fieldCrypto.js';

describe('Real AES-GCM supplier field encryption', () => {
  it.each(['old', 'old:', ' : '])('rejects malformed rotation entries', (entry) => {
    env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    env.FIELD_ENCRYPTION_KEY_PREVIOUS = entry;
    _resetCryptoCacheForTests();
    const value = encryptField('test');
    expect(() => decryptField(value)).toThrow();
  });
  const key = randomBytes(32),
    oldKey = randomBytes(32);
  beforeEach(() => {
    env.FIELD_ENCRYPTION_KEY = key.toString('base64');
    env.FIELD_ENCRYPTION_KEY_PREVIOUS = '';
    _resetCryptoCacheForTests();
  });
  it('encrypts Bangla supplier PII with a unique nonce and authenticates its ciphertext', () => {
    const a = encryptField('বাংলাদেশ supplier BIN 12345'),
      b = encryptField('বাংলাদেশ supplier BIN 12345');
    expect(a).not.toBe(b);
    expect(isEncryptedEnvelope(a)).toBe(true);
    expect(decryptField(a)).toBe('বাংলাদেশ supplier BIN 12345');
    const tampered = Buffer.from(a, 'base64');
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    expect(() => decryptField(tampered.toString('base64'))).toThrow();
  });
  it('decrypts historical ciphertext after key rotation', () => {
    env.FIELD_ENCRYPTION_KEY = oldKey.toString('hex');
    _resetCryptoCacheForTests();
    const old = encryptField('previous tax ID');
    env.FIELD_ENCRYPTION_KEY = key.toString('base64');
    env.FIELD_ENCRYPTION_KEY_PREVIOUS = `old:${oldKey.toString('base64')}`;
    _resetCryptoCacheForTests();
    expect(decryptField(old)).toBe('previous tax ID');
  });
  it('rejects unknown versions and truncated envelopes', () => {
    expect(() => decryptField('short')).toThrow('too short');
    expect(() => decryptField(Buffer.alloc(40, 9).toString('base64'))).toThrow('Unknown');
    expect(isEncryptedEnvelope('plain text')).toBe(false);
    expect(isEncryptedEnvelope(Buffer.alloc(40, 9).toString('base64'))).toBe(false);
  });
  it.each(['', 'wrong-key'])('rejects missing or malformed encryption key', (value) => {
    env.FIELD_ENCRYPTION_KEY = value;
    _resetCryptoCacheForTests();
    expect(() => encryptField('PII')).toThrow();
  });
  it('preserves empty optional fields', () => {
    expect(encryptField('')).toBe('');
    expect(decryptField('')).toBe('');
    expect(isEncryptedEnvelope('')).toBe(false);
  });
});
