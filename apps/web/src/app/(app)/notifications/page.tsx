import Link from 'next/link';
import { describeError } from '@/lib/api';
import { readAccessToken, requireCurrentUser } from '@/lib/session';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader } from '@/components/ui';
import {
  GROUP_HINTS,
  GROUP_LABELS,
  byGroup,
  describeQuietHours,
  heldUntil,
  loadNotificationPreferences,
  loadNotifications,
  type NotificationPreferences,
  type NotificationRow,
} from '@/lib/notifications';
import { MarkAllRead, MarkRead } from './notification-actions';
import { QuietHoursForm, TypeSwitch } from './_components/preference-forms';

/**
 * The notification centre (`FR-NOT-3`): a person's inbox, and the settings behind it.
 *
 * Notifications are written by outbox consumers, not by the request that caused them — so an
 * invitation accepted at 2am produces a row here without anyone being online. Everything is scoped
 * to the caller by the API; no permission gates it because there is nothing here but their own, and
 * there is deliberately no route by which a manager edits somebody's quiet hours.
 *
 * The settings sit **under** the list rather than on a separate screen. Somebody comes here because
 * of a notification they did or did not want, and making them find a second screen to act on that
 * is how a preferences page goes unused.
 */
export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  await requireCurrentUser();
  const token = await readAccessToken();

  let notifications: NotificationRow[] = [];
  let preferences: NotificationPreferences | null = null;
  let error: string | null = null;
  try {
    [notifications, preferences] = await Promise.all([
      loadNotifications(token),
      loadNotificationPreferences(token),
    ]);
  } catch (failure) {
    // No swallowing twin: on this screen "nothing is configured" and "the request failed" look
    // identical, and the second one would invite somebody to re-save settings they already have —
    // which on this screen means being woken up.
    error = describeError(failure);
  }

  const unread = notifications.filter((notification) => notification.readAt === null);

  return (
    <>
      <PageHeader
        title="Notifications"
        description={
          unread.length === 0
            ? 'Nothing needs your attention.'
            : `${unread.length} unread of the last ${notifications.length}.`
        }
        action={unread.length > 0 ? <MarkAllRead /> : undefined}
      />

      {error && <ErrorNotice>{error}</ErrorNotice>}

      <Card>
        {notifications.length === 0 ? (
          <EmptyState
            title="No notifications yet"
            description="You will hear about follow-ups, promises running out and anything that needs a decision."
          />
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--color-border)]">
            {notifications.map((notification) => {
              const held = heldUntil(notification);
              return (
                <li key={notification.id} className="flex items-start gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-baseline gap-2 text-sm font-medium">
                      {notification.link ? (
                        <Link href={notification.link} className="text-[var(--color-primary)]">
                          {notification.title}
                        </Link>
                      ) : (
                        notification.title
                      )}
                      {notification.readAt === null && <Badge tone="warning">New</Badge>}
                    </p>
                    {notification.body && (
                      <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">
                        {notification.body}
                      </p>
                    )}
                    <p className="numeric mt-1 text-xs text-[var(--color-text-muted)]">
                      {formatDateTime(notification.createdAt)}
                      {/*
                        Said out loud, because the alternative is somebody seeing a 21:40 timestamp
                        at nine in the morning and concluding the product is a night behind.
                      */}
                      {held && (
                        <span data-held={notification.id}>
                          {' · '}held for your quiet hours until {formatDateTime(held)}
                        </span>
                      )}
                    </p>
                  </div>
                  {notification.readAt === null && <MarkRead notificationId={notification.id} />}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {preferences && (
        <div className="mt-5 flex flex-col gap-5">
          <Card
            title="Quiet hours"
            description="Anything that arrives inside this window is held and delivered when it closes — and dropped instead if it has stopped being true by then."
          >
            <p className="mb-3 text-sm" data-quiet-summary>
              {describeQuietHours(preferences.quietHours, preferences.effectiveTimeZone)}
            </p>
            <QuietHoursForm preferences={preferences} />
          </Card>

          {byGroup(preferences.types).map((section) => (
            <Card
              key={section.group}
              title={GROUP_LABELS[section.group]}
              description={GROUP_HINTS[section.group]}
            >
              <div className="flex flex-col divide-y divide-[var(--color-border)]/60">
                {section.types.map((entry) => (
                  <TypeSwitch
                    key={entry.type}
                    entry={entry}
                    channels={preferences.deliverableChannels}
                  />
                ))}
              </div>
            </Card>
          ))}

          <p className="text-xs text-[var(--color-text-muted)]" data-channel-note>
            {/*
              The list comes from the API, so this sentence cannot drift from what the product can
              actually send — which is the point: a screen offering a tick box for a channel that
              drops every message is worse than one that says the channel is not here yet.
            */}
            In the app and by email. WhatsApp arrives with the shared inbox, and until it does this
            screen does not offer a tick box that would silently drop every message. An email is
            only sent once a held notification is released, so quiet hours mean quiet.
          </p>
        </div>
      )}
    </>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}
