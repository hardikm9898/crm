import { z } from 'zod';

/**
 * Boot-time configuration contract.
 *
 * The process refuses to start when a variable is missing or malformed, rather than
 * discovering it at 3 a.m. on the first Meta API call (docs/security.md §9,
 * docs/deployment-architecture.md §1).
 */

export const ROLES = ['api', 'collector', 'worker', 'scheduler'] as const;
export type ProcessRole = (typeof ROLES)[number];

const base64Key = (bytes: number) =>
  z.string().refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64').length === bytes;
      } catch {
        return false;
      }
    },
    { message: `must be ${bytes} raw bytes, base64-encoded (openssl rand -base64 ${bytes})` },
  );

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  ROLE: z.enum(ROLES).default('api'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),

  DATABASE_URL: z.string().refine((v) => v.startsWith('postgres'), 'must be a postgres:// URL'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  REDIS_URL: z.string().refine((v) => v.startsWith('redis'), 'must be a redis:// URL'),

  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('30d'),

  ENCRYPTION_MASTER_KEY: base64Key(32),

  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
});

export type AppConfig = z.infer<typeof configSchema>;

export class ConfigValidationError extends Error {
  constructor(issues: readonly { path: string; message: string }[]) {
    super(
      'Invalid configuration — refusing to start:\n' +
        issues.map((issue) => `  • ${issue.path}: ${issue.message}`).join('\n'),
    );
    this.name = 'ConfigValidationError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }

  const config = result.data;
  assertProductionSafety(config);
  return config;
}

/**
 * Guards against the most expensive class of misconfiguration: shipping development
 * secrets to production. Cheap to check, catastrophic to miss.
 */
function assertProductionSafety(config: AppConfig): void {
  if (config.NODE_ENV !== 'production') return;

  const problems: { path: string; message: string }[] = [];
  const looksLikeDevSecret = (value: string) => /dev-only|change-me|localhost|^a{8,}/i.test(value);

  if (looksLikeDevSecret(config.JWT_ACCESS_SECRET)) {
    problems.push({ path: 'JWT_ACCESS_SECRET', message: 'still the development placeholder' });
  }
  if (looksLikeDevSecret(config.JWT_REFRESH_SECRET)) {
    problems.push({ path: 'JWT_REFRESH_SECRET', message: 'still the development placeholder' });
  }
  if (config.JWT_ACCESS_SECRET === config.JWT_REFRESH_SECRET) {
    problems.push({ path: 'JWT_REFRESH_SECRET', message: 'must differ from JWT_ACCESS_SECRET' });
  }
  if (looksLikeDevSecret(config.ENCRYPTION_MASTER_KEY)) {
    problems.push({ path: 'ENCRYPTION_MASTER_KEY', message: 'still the development placeholder' });
  }
  if (config.DATABASE_URL.includes('localhost')) {
    problems.push({ path: 'DATABASE_URL', message: 'points at localhost in production' });
  }

  if (problems.length > 0) throw new ConfigValidationError(problems);
}
