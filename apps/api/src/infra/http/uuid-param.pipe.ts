import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { AppError } from '@leados/shared';

/**
 * Refuses a path parameter that is not a UUID, before it reaches the database.
 *
 * Without this, `GET /leads/not-a-uuid` reached Prisma, which answered
 * `invalid input syntax for type uuid: "not-a-uuid"` — a **500**. Every `:id` route in the product
 * had it, which is the kind of thing a crawler, a stale bookmark or a typo in a support ticket finds
 * within a day: the log fills with internal errors for requests that were simply wrong, and a real
 * fault becomes impossible to spot among them.
 *
 * **404, not 400.** A malformed id and an id belonging to another tenant must be indistinguishable
 * from the outside — the whole API answers "not found" for the second, and answering 400 for the
 * first would turn the shape of an id into an oracle. It also happens to be what a person means:
 * the thing you asked for is not there.
 *
 * Registered **globally** rather than as `@Param('id', ParseUUIDPipe)` on seventy-two call sites.
 * That is not only less typing: a route added next week is covered without anybody remembering, in
 * the same spirit as the boot-time route-authorization audit. It applies to parameters named `id`
 * or ending in `Id`, so a future `:slug` or `:provider` is untouched.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class UuidParamPipe implements PipeTransform<string, string> {
  transform(value: string, metadata: ArgumentMetadata): string {
    if (metadata.type !== 'param') return value;
    const name = metadata.data;
    if (name !== 'id' && !(typeof name === 'string' && name.endsWith('Id'))) return value;
    if (typeof value === 'string' && UUID.test(value)) return value;
    throw AppError.notFound('Resource');
  }
}
