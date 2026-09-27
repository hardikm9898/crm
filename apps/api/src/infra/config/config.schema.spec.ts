import { describe, expect, it } from 'vitest';
import { ConfigValidationError, loadConfig } from './config.schema.js';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@db:5432/leados',
  REDIS_URL: 'redis://cache:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
  ENCRYPTION_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('configuration validation', () => {
  it('applies documented defaults', () => {
    const config = loadConfig({ ...valid } as NodeJS.ProcessEnv);
    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(4000);
    expect(config.ROLE).toBe('api');
    expect(config.DATABASE_POOL_MAX).toBe(10);
  });

  it('refuses to start without a database url', () => {
    const { DATABASE_URL: _omitted, ...rest } = valid;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(ConfigValidationError);
  });

  it('names every offending variable at once, so one restart fixes all of them', () => {
    try {
      loadConfig({} as NodeJS.ProcessEnv);
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('REDIS_URL');
      expect(message).toContain('JWT_ACCESS_SECRET');
      expect(message).toContain('ENCRYPTION_MASTER_KEY');
    }
  });

  it('rejects a master key that is not 32 bytes', () => {
    expect(() =>
      loadConfig({
        ...valid,
        ENCRYPTION_MASTER_KEY: Buffer.alloc(16).toString('base64'),
      } as NodeJS.ProcessEnv),
    ).toThrow(/32 raw bytes/);
  });

  it('rejects a short JWT secret', () => {
    expect(() =>
      loadConfig({ ...valid, JWT_ACCESS_SECRET: 'tooshort' } as NodeJS.ProcessEnv),
    ).toThrow(/at least 32 characters/);
  });

  it('rejects an unknown process role', () => {
    expect(() => loadConfig({ ...valid, ROLE: 'nonsense' } as NodeJS.ProcessEnv)).toThrow(
      ConfigValidationError,
    );
  });

  describe('production safety net', () => {
    const production = { ...valid, NODE_ENV: 'production' } as NodeJS.ProcessEnv;

    it('blocks development placeholder secrets reaching production', () => {
      expect(() =>
        loadConfig({
          ...production,
          JWT_ACCESS_SECRET: 'dev-only-access-secret-change-me-0000000000',
        } as NodeJS.ProcessEnv),
      ).toThrow(/development placeholder/);
    });

    it('blocks reusing one secret for both access and refresh tokens', () => {
      expect(() =>
        loadConfig({
          ...production,
          JWT_ACCESS_SECRET: 'x'.repeat(40),
          JWT_REFRESH_SECRET: 'x'.repeat(40),
        } as NodeJS.ProcessEnv),
      ).toThrow(/must differ/);
    });

    it('blocks a localhost database in production', () => {
      expect(() =>
        loadConfig({
          ...production,
          DATABASE_URL: 'postgresql://user:pass@localhost:5432/leados',
        } as NodeJS.ProcessEnv),
      ).toThrow(/localhost/);
    });

    it('accepts a properly configured production environment', () => {
      expect(() =>
        loadConfig({
          ...production,
          JWT_ACCESS_SECRET: 'p'.repeat(48),
          JWT_REFRESH_SECRET: 'q'.repeat(48),
          ENCRYPTION_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
        } as NodeJS.ProcessEnv),
      ).not.toThrow();
    });
  });
});
