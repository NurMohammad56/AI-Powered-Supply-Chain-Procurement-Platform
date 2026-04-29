import { z } from 'zod';

const NodeEnv = z.enum(['development', 'staging', 'production', 'test']);

const truthy = (raw: unknown) =>
  typeof raw === 'string' ? ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase()) : Boolean(raw);

const numericString = (def: number) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .pipe(z.number().int().nonnegative())
    .default(def);

const envSchema = z.object({
  NODE_ENV: NodeEnv.default('development'),
  PORT: numericString(4000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  GIT_SHA: z.string().default('local'),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  MONGO_MAX_POOL_SIZE: numericString(20),
  MONGO_MIN_POOL_SIZE: numericString(5),

  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  REDIS_TLS: z.preprocess(truthy, z.boolean()).default(false),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be >= 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be >= 32 chars'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  JWT_ISSUER: z.string().default('scp-platform'),
  JWT_AUDIENCE: z.string().default('scp-platform-clients'),

  BCRYPT_COST: numericString(12).refine((n) => n >= 12, 'BCRYPT_COST must be >= 12'),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),

  COOKIE_DOMAIN: z.string().default('localhost'),
  COOKIE_SECURE: z.preprocess(truthy, z.boolean()).default(false),

  RATE_LIMIT_UNAUTH_PER_MIN: numericString(60),
  RATE_LIMIT_AUTH_PER_MIN: numericString(600),
  RATE_LIMIT_TENANT_PER_MIN: numericString(6000),

  RESEND_API_KEY: z.string().default(''),
  EMAIL_FROM: z.string().email().default('noreply@factory.bd'),
  EMAIL_REPLY_TO: z.string().email().default('support@factory.bd'),

  GROQ_API_KEY: z.string().default(''),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-1.5-flash'),
  AI_PER_CALL_TIMEOUT_MS: numericString(30_000),
  AI_FAILURE_THRESHOLD: numericString(3),
  AI_COOLDOWN_MS: numericString(60_000),

  R2_ACCOUNT_ID: z.string().default(''),
  R2_ACCESS_KEY_ID: z.string().default(''),
  R2_SECRET_ACCESS_KEY: z.string().default(''),
  R2_BUCKET: z.string().default(''),
  R2_ENDPOINT: z.string().default(''),
  R2_PUBLIC_URL_TTL_SECONDS: numericString(300),

  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  SSLCOMMERZ_STORE_ID: z.string().default(''),
  SSLCOMMERZ_STORE_PASSWORD: z.string().default(''),
  SSLCOMMERZ_IS_LIVE: z.preprocess(truthy, z.boolean()).default(false),

  SENTRY_DSN: z.string().default(''),
  SENTRY_TRACES_SAMPLE_RATE: z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .pipe(z.number().min(0).max(1))
    .default(0.1),

  FRONTEND_BASE_URL: z.string().url().default('http://localhost:3000'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`\nInvalid environment variables:\n${issues}\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isStaging = env.NODE_ENV === 'staging';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';
