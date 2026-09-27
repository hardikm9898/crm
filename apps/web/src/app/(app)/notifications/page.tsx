import Link from 'next/link';
import { describeError, request } from '@/lib/api';
import { readAccessToken, requireCurrentUser } from '@/lib/session';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader } from '@/components/ui';
import { MarkAllRead, MarkRead } from './notification-actions';

/**
 * A person's notification inbox.
 *
 * Notifications are written by outbox consumers, not by the request that caused them — so an
 * invitation accepted at 2am produces a row here without anyone being online. The list is scoped to
 * the caller by the API; no permission gates it because there is nothing here but their own.
 */
interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export default async function NotificationsPage() {
  await requireCurrentUser();
  const token = await readAccessToken();

  let notifications: NotificationRow[] = [];
  let error: string | null = null;
  try {
    const response = await request<NotificationRow[]>('/notifications?limit=50', { token });
    notifications = Array.isArray(response.data) ? response.data : [];
  } catch (failure) {
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
            description="You will hear about invitations, assignments and anything that needs a decision."
          />
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--color-border)]">
            {notifications.map((notification) => (
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
                  </p>
                </div>
                {notification.readAt === null && <MarkRead notificationId={notification.id} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
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
