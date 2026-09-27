import pino, { type Logger } from 'pino';
import type { LoggerService } from '@nestjs/common';
import { requestStore } from '../http/request-store.js';

/**
 * Structured JSON logs with the request id, organization and user on every line, and a
 * redaction list so credentials and PII never reach a log aggregator
 * (docs/security.md §9, NFR-OBS-1).
 */
const REDACTED = [
  'req.headers.authorization',
  'req.headers.cookie',
  'password',
  'passwordHash',
  'token',
  'refreshToken',
  'accessToken',
  'secret',
  'credentials',
  'signature',
  'otp',
  'phone',
  'phoneE164',
  'email',
  '*.password',
  '*.token',
  '*.secret',
  '*.email',
  '*.phone',
];

export function createRootLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    redact: { paths: REDACTED, censor: '[redacted]' },
    base: { service: 'api' },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });
}

/** Bridges Nest's LoggerService onto pino, so framework logs are structured too. */
export class PinoLoggerService implements LoggerService {
  constructor(private readonly logger: Logger) {}

  private withContext(context?: unknown): Record<string, unknown> {
    const request = requestStore.get();
    return {
      ...(typeof context === 'string' ? { context } : {}),
      ...(request ? { requestId: request.requestId } : {}),
    };
  }

  log(message: unknown, context?: unknown): void {
    this.logger.info(this.withContext(context), String(message));
  }
  error(message: unknown, stack?: unknown, context?: unknown): void {
    this.logger.error({ ...this.withContext(context), stack }, String(message));
  }
  warn(message: unknown, context?: unknown): void {
    this.logger.warn(this.withContext(context), String(message));
  }
  debug(message: unknown, context?: unknown): void {
    this.logger.debug(this.withContext(context), String(message));
  }
  verbose(message: unknown, context?: unknown): void {
    this.logger.trace(this.withContext(context), String(message));
  }
}
