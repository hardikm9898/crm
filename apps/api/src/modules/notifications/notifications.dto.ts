import { z } from 'zod';
import { NOTIFICATION_CHANNELS, parseMinuteOfDay } from '@leados/shared';

/**
 * A time of day as `21:30`, not as a number of minutes.
 *
 * The API speaks in the same units a person reads, and the storage speaks in minutes on a local
 * day. `parseMinuteOfDay` refuses what `Number()` would accept — `'9:00'`, `'24:00'`, `'21:60'` —
 * which is the lesson the reminder offsets paid for.
 */
const timeOfDay = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const minute = parseMinuteOfDay(value);
    if (minute === null) {
      ctx.addIssue({ code: 'custom', message: 'Use a time of day like 21:30' });
      return z.NEVER;
    }
    return minute;
  });

const quietHours = z
  .object({ start: timeOfDay, end: timeOfDay })
  .strict()
  .transform((value) => ({ startMinute: value.start, endMinute: value.end }));

export const updateNotificationPreferencesSchema = z
  .object({
    /**
     * `null` clears the window; an absent key leaves it alone. The three-way shape matters here
     * for the same reason it matters on a query flag: folding "not mentioned" into "off" would let
     * a screen that only edits the type list silently switch somebody's quiet hours off.
     */
    quietHours: quietHours.nullable().optional(),
    timeZone: z.string().trim().min(1).max(64).nullable().optional(),
    types: z
      .array(
        z
          .object({
            type: z.string().trim().min(1).max(60),
            channels: z.array(z.enum(NOTIFICATION_CHANNELS)).max(NOTIFICATION_CHANNELS.length),
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strict();

export type UpdateNotificationPreferencesInput = z.infer<
  typeof updateNotificationPreferencesSchema
>;
