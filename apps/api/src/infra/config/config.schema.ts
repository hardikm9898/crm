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

export const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),
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

    /**
     * Where uploaded and generated files live. Only the local driver exists today (the S3 driver
     * arrives with the media-heavy phases); the variable exists so switching is configuration rather
     * than a code change, and so a deployment states its choice out loud.
     */
    STORAGE_DRIVER: z.enum(['local']).default('local'),
    STORAGE_LOCAL_ROOT: z.string().default('.data/storage'),
    /**
     * The largest file an upload may carry. 20 MB is roughly 150 000 lead rows — far more than the
     * per-import row cap — and small enough that a request body cannot exhaust the API's memory.
     */
    UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(200 * 1_024 * 1_024)
      .default(20 * 1_024 * 1_024),
    /** How long an export stays downloadable before the sweep drops its bytes (`FR-IO-3`). */
    EXPORT_RETENTION_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(72),

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

    /**
     * Which email driver sends. `log` writes the message to the log and sends nothing; it refuses to
     * run in production, because a silently-not-sending mailer there means nobody receives a password
     * reset while every request returns 200 — the worst kind of failure, because it looks like
     * success.
     *
     * The variable exists so a deployment states its choice out loud, the same reason
     * `STORAGE_DRIVER` does.
     */
    EMAIL_DRIVER: z.enum(['log', 'postmark']).default('log'),
    /** `Name <address>`. The address's domain is the one whose reputation the suppression list guards. */
    EMAIL_FROM: z.string().default('Lead OS <no-reply@leados.local>'),
    EMAIL_REPLY_TO: z.string().optional(),
    POSTMARK_SERVER_TOKEN: z.string().optional(),
    POSTMARK_API_URL: z.string().url().default('https://api.postmarkapp.com'),
    /**
     * Meta's Graph API, versioned.
     *
     * Configurable for the same reason `POSTMARK_API_URL` is: it is what makes the Meta Lead Ads
     * adapter genuinely testable — the suite points it at an in-process server and gets a real
     * fetch over real HTTP. The version is in the base URL because Meta's are dated and a bump is
     * a deployment decision, not a code change.
     */
    META_GRAPH_URL: z.string().url().default('https://graph.facebook.com/v21.0'),
    /**
     * The shared secret a provider's delivery webhook must present.
     *
     * Required the moment a real driver is configured: the webhook is the only thing that writes the
     * suppression list, so an unauthenticated one lets anybody stop a workspace's mail.
     */
    EMAIL_WEBHOOK_SECRET: z.string().min(16).optional(),
  })
  .superRefine((config, ctx) => {
    // Checked here rather than at the first send: a deployment that cannot send mail should fail to
    // start, not fail silently three hours later on somebody's password reset.
    if (config.EMAIL_DRIVER === 'postmark' && !config.POSTMARK_SERVER_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        path: ['POSTMARK_SERVER_TOKEN'],
        message: 'is required when EMAIL_DRIVER=postmark',
      });
    }
    if (config.EMAIL_DRIVER !== 'log' && !config.EMAIL_WEBHOOK_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_WEBHOOK_SECRET'],
        message:
          'is required with a real email driver: the delivery webhook is the only writer of the suppression list',
      });
    }
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
