import { Injectable, type PipeTransform } from '@nestjs/common';
import { AppError, type FieldError } from '@leados/shared';
import type { ZodType } from 'zod';

/**
 * Validates a request body against a Zod schema and maps failures onto the API's
 * field-error contract, so a client can render messages inline
 * (docs/api-architecture.md §2).
 *
 * Used per-route rather than globally, because the schema belongs to the endpoint.
 */
@Injectable()
export class ZodBody<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;

    const details: FieldError[] = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(body)',
      code: issue.code.toUpperCase(),
      message: issue.message,
    }));
    throw AppError.validation('Some details need correcting', details);
  }
}

/** `@Body(zodBody(schema))` reads better at the call site than `new ZodBody(schema)`. */
export function zodBody<T>(schema: ZodType<T>): ZodBody<T> {
  return new ZodBody(schema);
}
