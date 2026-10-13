import { z } from 'zod';
import { OVERSIGHT_WINDOWS, isOversightWindow } from '@leados/shared';

/**
 * `GET /oversight` takes one parameter: how far back to look.
 *
 * Unlike `/my/today`, a **period is** a question a manager asks — "this week" and "this quarter"
 * are different conversations about the same team. Everything else is decided by the caller's data
 * scope, as it is on `/sla/board`: a route called `/dashboard/manager` would be a second
 * implementation of a predicate `DataScopeService` already owns, and a path named after a role is
 * the thing rule 4 forbids.
 *
 * The windows themselves are in `@leados/shared`, because the screen's period tabs and the sentence
 * each card writes about "the last N days" have to agree with this schema — a fourth window added
 * in one place alone is a tab that answers 400.
 */
export const oversightQuerySchema = z
  .object({
    days: z.coerce
      .number()
      .int()
      .refine(isOversightWindow, {
        message: `Choose one of ${OVERSIGHT_WINDOWS.join(', ')} days`,
      })
      .default(30),
  })
  .strict();

export type OversightQuery = z.infer<typeof oversightQuerySchema>;

/** How many people the table carries. Beyond this it is an export, not a screen. */
export const OVERSIGHT_PEOPLE_LIMIT = 50;
