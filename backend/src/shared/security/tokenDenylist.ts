import { redisCache } from '../../config/redis.js';
import { logger } from '../../config/logger.js';

/**
 * Redis-backed access-token denylist (Prompt 06 §1).
 *
 * Why two layers (DB + Redis)?
 *   - Refresh tokens already track family/jti in MongoDB so reuse
 *     detection and admin revocation work without Redis.
 *   - Access tokens are short-lived (15 min) so we cannot hit Mongo on
 *     every request without taking a noticeable latency hit. The Redis
 *     denylist is the FAST PATH consulted by the resolveTenant middleware
 *     immediately after JWT signature verification. Each denylist entry
 *     auto-expires when the underlying token expires, so the set never
 *     grows unbounded.
 *
 * Use cases:
 *   - Logout-everywhere: enumerate the user's active access tokens and
 *     denylist every jti.
 *   - Force re-authentication after role change.
 *   - Incident response: an operator can denylist a leaked jti on demand.
 */

const PREFIX = 'auth:deny:jti:';
const USER_PREFIX = 'auth:deny:user:';
const SAFETY_TTL_SECONDS = 24 * 60 * 60; // 1 day cap; matches max JWT TTL

/**
 * Denylist a single JTI. `expiresAt` should be the access token's
 * original `exp` claim - the entry self-evicts after that point so
 * leaked tokens stop wasting Redis memory once they would have expired
 * naturally.
 */
export async function denylistJti(jti: string, expiresAt: Date): Promise<void> {
  if (!jti) return;
  const ttlSeconds = Math.max(1, Math.min(SAFETY_TTL_SECONDS, Math.ceil((expiresAt.getTime() - Date.now()) / 1000)));
  try {
    await redisCache.set(`${PREFIX}${jti}`, '1', 'EX', ttlSeconds, 'NX');
  } catch (err) {
    logger.warn({ err, event: 'auth.denylist.write_failed', jti }, 'denylist write degraded');
  }
}

/**
 * Denylist every access token currently belonging to a user. We do not
 * track every jti in Redis upfront; instead we set a "user revoked at"
 * watermark that the verify path reads, and any access token whose
 * `iat` is older is rejected. Combined with the 15-minute access-token
 * TTL this gives a hard cap on staleness without enumerating every jti.
 */
export async function denylistAllForUser(userId: string): Promise<void> {
  if (!userId) return;
  try {
    await redisCache.set(`${USER_PREFIX}${userId}`, Date.now().toString(), 'EX', SAFETY_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err, event: 'auth.denylist.user_failed', userId }, 'user denylist write degraded');
  }
}

/**
 * Returns true if the access token should be rejected. Cheap: two
 * O(1) Redis lookups in parallel. On Redis failure the function fails
 * OPEN (returns false) - we prefer availability over revocation
 * latency for short-lived tokens, since the refresh path is the
 * authoritative revocation gate.
 */
export async function isAccessTokenDenied(args: {
  jti: string;
  userId: string;
  issuedAtSec: number;
}): Promise<boolean> {
  try {
    const [jtiHit, userWatermark] = await Promise.all([
      redisCache.get(`${PREFIX}${args.jti}`),
      redisCache.get(`${USER_PREFIX}${args.userId}`),
    ]);
    if (jtiHit) return true;
    if (userWatermark) {
      const watermark = Number(userWatermark);
      if (Number.isFinite(watermark) && args.issuedAtSec * 1000 < watermark) {
        return true;
      }
    }
    return false;
  } catch (err) {
    logger.warn({ err, event: 'auth.denylist.read_failed' }, 'denylist read degraded; failing open');
    return false;
  }
}

/** Test-only escape hatch. */
export async function _clearDenylistForTests(): Promise<void> {
  const keys = await redisCache.keys(`${PREFIX}*`);
  if (keys.length > 0) await redisCache.del(...keys);
  const userKeys = await redisCache.keys(`${USER_PREFIX}*`);
  if (userKeys.length > 0) await redisCache.del(...userKeys);
}
