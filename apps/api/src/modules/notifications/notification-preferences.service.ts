import { Injectable } from '@nestjs/common';
import {
  AppError,
  DELIVERABLE_CHANNELS,
  NOTIFICATION_TYPES,
  isDeliverableChannel,
  isMinuteOfDay,
  isValidTimeZone,
  newId,
  notificationType,
  tenantContext,
} from '@leados/shared';
import { DbService } from '../../infra/db/db.service.js';
import type { UpdateNotificationPreferencesInput } from './notifications.dto.js';

/**
 * A person's own notification settings (`FR-NOT-3`).
 *
 * Read and written by the person they belong to, and nobody else: there is no route by which a
 * manager edits somebody's quiet hours. That is deliberate — a preference somebody else can change
 * is not a preference, and "the system kept telling me at 11pm" would become unanswerable.
 *
 * Two rows behind one screen:
 *
 *  * `notification_settings` — the person's quiet window and the zone it is read in. **One row**,
 *    because quiet hours are a property of the person, not of a notification type.
 *  * `notification_preferences` — which channels each type goes out on. One row per type the person
 *    has actually changed; absence means the registry's default, so a new type reaches everybody
 *    without a backfill.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly db: DbService) {}

  async read() {
    const principal = tenantContext.require('notifications.preferences.read');
    const userId = principal.actorId ?? '';
    const organizationId = tenantContext.organizationId('notifications.preferences');

    const [settings, rows, organization] = await Promise.all([
      this.db.client.notificationSetting.findUnique({
        where: { notification_setting_person_key: { organizationId, userId } },
      }),
      this.db.client.notificationPreference.findMany({ where: { userId } }),
      this.db.client.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { timezone: true },
      }),
    ]);

    const chosen = new Map(
      rows.map((row) => [
        row.type,
        Array.isArray(row.channels)
          ? row.channels.filter((entry): entry is string => typeof entry === 'string')
          : [],
      ]),
    );

    return {
      quietHours:
        settings?.quietStartMinute === null || settings?.quietStartMinute === undefined
          ? null
          : { startMinute: settings.quietStartMinute, endMinute: settings.quietEndMinute },
      /** What the person chose, and what it resolves to — the screen shows both. */
      timeZone: settings?.timeZone ?? null,
      effectiveTimeZone: settings?.timeZone ?? organization.timezone,
      workspaceTimeZone: organization.timezone,
      /** Every channel that can actually be delivered today, so the screen offers only those. */
      deliverableChannels: [...DELIVERABLE_CHANNELS],
      types: NOTIFICATION_TYPES.map((spec) => ({
        type: spec.type,
        label: spec.label,
        hint: spec.hint,
        group: spec.group,
        optOut: spec.optOut,
        defaultChannels: [...spec.defaultChannels],
        /** `null` when the person has never touched it: the screen can say "default". */
        channels: chosen.get(spec.type) ?? null,
        effectiveChannels: spec.optOut
          ? (chosen.get(spec.type) ?? [...spec.defaultChannels])
          : [...spec.defaultChannels],
      })),
    };
  }

  /**
   * Replaces what was sent and leaves the rest alone.
   *
   * A `PUT` that took the whole screen would mean a stale tab overwriting a change made on a phone
   * five minutes earlier; a `PATCH` shape, where an absent key means "unchanged" and
   * `quietHours: null` means "clear it", is what a settings screen actually needs.
   */
  async update(input: UpdateNotificationPreferencesInput) {
    const principal = tenantContext.require('notifications.preferences.update');
    const userId = principal.actorId ?? '';
    const organizationId = tenantContext.organizationId('notifications.preferences');

    if (input.quietHours !== undefined || input.timeZone !== undefined) {
      await this.writeSettings(organizationId, userId, input);
    }

    for (const entry of input.types ?? []) {
      const spec = notificationType(entry.type);
      if (!spec) throw AppError.validation('That is not a notification this product sends', []);
      if (!spec.optOut) {
        // `FR-NOT-3`: system notices are not opt-out. Refused rather than silently ignored, so
        // nobody is left believing they turned something off.
        throw AppError.businessRule(
          `“${spec.label}” cannot be switched off — it is how you find out the workspace's subscription has lapsed.`,
        );
      }
      const channels = entry.channels.filter(isDeliverableChannel);
      if (channels.length !== entry.channels.length) {
        throw AppError.validation(
          `Only ${DELIVERABLE_CHANNELS.join(', ')} can be delivered today; email and WhatsApp arrive with their channels`,
          [],
        );
      }
      await this.db.client.notificationPreference.upsert({
        where: { organizationId_userId_type: { organizationId, userId, type: entry.type } },
        create: { id: newId(), organizationId, userId, type: entry.type, channels },
        update: { channels },
      });
    }

    return this.read();
  }

  private async writeSettings(
    organizationId: string,
    userId: string,
    input: UpdateNotificationPreferencesInput,
  ): Promise<void> {
    const quiet = input.quietHours;
    if (quiet) {
      if (!isMinuteOfDay(quiet.startMinute) || !isMinuteOfDay(quiet.endMinute)) {
        throw AppError.validation('A quiet hour has to be a time of day', []);
      }
      if (quiet.startMinute === quiet.endMinute) {
        // The database refuses it too. Answered here so the message is a sentence rather than a
        // constraint name: equal ends could mean "never quiet" or "all day", and guessing which
        // would be guessing about when to wake somebody up.
        throw AppError.validation(
          'Quiet hours need a start and an end that differ — pick the window you do not want to be told in',
          [],
        );
      }
    }
    if (input.timeZone !== undefined && input.timeZone !== null) {
      if (!isValidTimeZone(input.timeZone)) {
        throw AppError.validation('That is not a timezone this system knows', []);
      }
    }

    const existing = await this.db.client.notificationSetting.findUnique({
      where: { notification_setting_person_key: { organizationId, userId } },
      select: { id: true },
    });

    const data = {
      ...(input.quietHours === undefined
        ? {}
        : {
            quietStartMinute: input.quietHours?.startMinute ?? null,
            quietEndMinute: input.quietHours?.endMinute ?? null,
          }),
      ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
    };

    if (existing) {
      await this.db.client.notificationSetting.update({ where: { id: existing.id }, data });
      return;
    }
    await this.db.client.notificationSetting.create({
      data: { id: newId(), organizationId, userId, ...data },
    });
  }
}
