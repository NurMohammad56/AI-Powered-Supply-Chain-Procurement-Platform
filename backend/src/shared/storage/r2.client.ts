import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Cloudflare R2 client (S3-compatible). Lazy-initialised so that a
 * dev environment without R2 credentials can still boot - calls return
 * a `mocked` result and log a warning instead of throwing.
 *
 * R2 differs from S3 only in:
 *   - Endpoint URL (account-scoped subdomain)
 *   - Region must be 'auto'
 *   - Path-style bucket access required
 */

let cachedClient: S3Client | null = null;

function isConfigured(): boolean {
  return Boolean(
    env.R2_ACCOUNT_ID &&
      env.R2_ACCESS_KEY_ID &&
      env.R2_SECRET_ACCESS_KEY &&
      env.R2_BUCKET &&
      (env.R2_ENDPOINT || env.R2_ACCOUNT_ID),
  );
}

function client(): S3Client {
  if (cachedClient) return cachedClient;
  const endpoint = env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  cachedClient = new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
  return cachedClient;
}

export interface UploadObjectInput {
  key: string;
  body: Buffer | Uint8Array;
  contentType: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface UploadObjectResult {
  key: string;
  bucket: string;
  /** Presigned GET URL with TTL `R2_PUBLIC_URL_TTL_SECONDS`. */
  url: string;
  uploaded: boolean;
}

/**
 * Upload an object to R2 and return a presigned download URL valid for
 * `R2_PUBLIC_URL_TTL_SECONDS` (default 5 minutes).
 *
 * In development without R2 credentials, returns a stub URL so the
 * caller chain keeps working end-to-end.
 */
export async function uploadObject(input: UploadObjectInput): Promise<UploadObjectResult> {
  if (!isConfigured()) {
    logger.warn(
      { event: 'r2.stub_upload', key: input.key, size: input.body.byteLength },
      'R2 not configured; returning stub URL',
    );
    return {
      key: input.key,
      bucket: 'stub-bucket',
      url: `stub://r2/${input.key}`,
      uploaded: false,
    };
  }
  const params: PutObjectCommandInput = {
    Bucket: env.R2_BUCKET,
    Key: input.key,
    Body: input.body,
    ContentType: input.contentType,
    CacheControl: input.cacheControl ?? 'private, max-age=300',
    Metadata: input.metadata,
  };
  await client().send(new PutObjectCommand(params));
  const url = await presignGet(input.key);
  return {
    key: input.key,
    bucket: env.R2_BUCKET,
    url,
    uploaded: true,
  };
}

/** Generate a fresh presigned URL for an existing object. */
export async function presignGet(key: string, ttlSeconds?: number): Promise<string> {
  if (!isConfigured()) {
    return `stub://r2/${key}`;
  }
  const command = new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key });
  return getSignedUrl(client(), command, {
    expiresIn: ttlSeconds ?? env.R2_PUBLIC_URL_TTL_SECONDS,
  });
}

/**
 * Build a deterministic R2 key for a tenant-scoped artefact. Keys are
 * always tenant-prefixed so a single `aws s3 ls` invocation can scope
 * to one tenant during incident response.
 */
export function tenantKey(tenantId: string, kind: string, filename: string): string {
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const datePrefix = new Date().toISOString().slice(0, 10);
  return `tenants/${tenantId}/${kind}/${datePrefix}/${safeFilename}`;
}
