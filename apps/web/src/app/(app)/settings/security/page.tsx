import { describeError, request } from '@/lib/api';
import { readAccessToken, requireCurrentUser } from '@/lib/session';
import { Badge, Card, DataTable, EmptyState, ErrorNotice, PageHeader } from '@/components/ui';
import { SessionActions } from './session-actions';

/**
 * A person's own account security.
 *
 * No permission gates this page — it is about the caller's own account, and the API scopes every
 * query here to them. Being able to see *and end* your own sessions is what makes "I signed in on a
 * shared computer" recoverable without an administrator (docs/security.md §2).
 */
interface SessionRow {
  id: string;
  current: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export default async function SecurityPage() {
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  let sessions: SessionRow[] = [];
  let error: string | null = null;
  try {
    const response = await request<SessionRow[]>('/auth/sessions', { token });
    sessions = Array.isArray(response.data) ? response.data : [];
  } catch (failure) {
    error = describeError(failure);
  }

  return (
    <>
      <PageHeader
        title="Your security"
        description="Where you are signed in, and how this account is protected."
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card
          title="Active sessions"
          description="Ending a session signs that device out immediately."
          action={sessions.length > 1 ? <SessionActions scope="all" /> : undefined}
        >
          {error && <ErrorNotice>{error}</ErrorNotice>}
          {sessions.length === 0 && !error ? (
            <EmptyState title="No other sessions" />
          ) : (
            <DataTable columns={['Device', 'Signed in', 'Last used', '']}>
              {sessions.map((session) => (
                <tr key={session.id} className="align-top">
                  <td className="py-2.5 pr-4">
                    <p className="text-sm">
                      {describeDevice(session.userAgent)}
                      {session.current && (
                        <span className="ml-2">
                          <Badge tone="success">This device</Badge>
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      {session.ipAddress ?? 'Unknown address'}
                    </p>
                  </td>
                  <td className="numeric py-2.5 pr-4 text-xs text-[var(--color-text-muted)]">
                    {formatDateTime(session.createdAt)}
                  </td>
                  <td className="numeric py-2.5 pr-4 text-xs text-[var(--color-text-muted)]">
                    {formatDateTime(session.lastUsedAt)}
                  </td>
                  <td className="py-2.5 text-right">
                    {!session.current && <SessionActions scope="one" sessionId={session.id} />}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </Card>

        <div className="flex flex-col gap-5">
          <Card title="Account">
            <dl className="flex flex-col gap-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[var(--color-text-muted)]">Email confirmed</dt>
                <dd>
                  {user.user.emailVerified ? (
                    <Badge tone="success">Yes</Badge>
                  ) : (
                    <Badge tone="warning">Not yet</Badge>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[var(--color-text-muted)]">Two-factor</dt>
                <dd>
                  {user.user.mfaEnabled ? (
                    <Badge tone="success">On</Badge>
                  ) : (
                    <Badge tone="warning">Off</Badge>
                  )}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-[var(--color-text-muted)]">
              Turning two-factor authentication on and off is available through the API; the screens
              for it arrive with the account settings work in a later phase.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}

/**
 * A user agent string is not a device name. Rather than pretend to parse one precisely, this reduces
 * it to the part a person can recognise and leaves the rest alone.
 */
function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const platform = /\((?<platform>[^)]+)\)/.exec(userAgent)?.groups?.['platform'];
  const browser = /(Firefox|Edg|Chrome|Safari)\/[\d.]+/.exec(userAgent)?.[1];
  const named = browser === 'Edg' ? 'Edge' : browser;
  if (!platform && !named) return userAgent.slice(0, 60);
  return [named, platform?.split(';')[0]?.trim()].filter(Boolean).join(' · ');
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
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
