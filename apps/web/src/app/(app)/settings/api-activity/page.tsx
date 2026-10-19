import Link from 'next/link';
import { describeError } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Card, EmptyState, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import { relativeWhen } from '@/lib/forms';
import { loadApiKeys, type ApiKeyRecord } from '@/lib/ingestion';
import {
  STATUS_CLASS_CLASSES,
  STATUS_CLASS_LABELS,
  SURFACE_LABELS,
  describeApiActivity,
  describeDuration,
  describeKeyUsage,
  loadApiLog,
  loadKeyUsage,
  statusClass,
  type ApiKeyUsage,
  type ApiLogRow,
  type ApiLogSummary,
} from '@/lib/api-surface';

/**
 * What this workspace's keys have been doing (`FR-API-1`, `FR-SA-4`).
 *
 * Behind `api_key:manage`, with the keys: the person who may create a credential is the person who
 * has to find out why one is being refused. It is a separate screen from the keys themselves
 * because the two are read at different moments — a key is made once, and this is opened every
 * time an integration stops working.
 *
 * It leads with the refusals. A screen that led with the whole log would bury the handful of rows
 * somebody has to act on under the hundreds that worked, which is the argument `/ingestion` and the
 * forms screen both make.
 *
 * No request or response **bodies** are here, on purpose: holding `api_key:manage` must not become
 * a way to read leads. What is here is the method, the path without its query string, the answer
 * and how long it took.
 */
export const dynamic = 'force-dynamic';

export default async function ApiActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string; status?: string }>;
}) {
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  if (!can(user, 'api_key:manage')) {
    return (
      <>
        <PageHeader title="API activity" />
        <ErrorNotice>Your role does not include this workspace’s API.</ErrorNotice>
      </>
    );
  }

  const params = await searchParams;
  const filters = new URLSearchParams({ limit: '100' });
  if (params.key) filters.set('apiKeyId', params.key);
  if (params.status) filters.set('status', params.status);

  let log: { items: ApiLogRow[]; total: number; summary: ApiLogSummary };
  let keys: ApiKeyRecord[];
  let usage: ApiKeyUsage[];
  try {
    [log, keys, usage] = await Promise.all([
      loadApiLog(token, `?${filters.toString()}`),
      loadApiKeys(token),
      loadKeyUsage(token),
    ]);
  } catch (error) {
    // A throwing loader on a screen whose whole job is to list requests: "nothing yet" and "we
    // could not ask" must not look the same here.
    return (
      <>
        <PageHeader title="API activity" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  const usageByKey = new Map(usage.map((row) => [row.apiKeyId, row]));
  const refused = log.items.filter((row) => statusClass(row.statusCode) !== 'success');

  return (
    <>
      <PageHeader
        title="API activity"
        description="Every request a key made to this workspace, with what we answered and how long it took. Kept for thirty days."
        action={
          <Link href="/settings/api-keys" className="text-sm underline">
            The keys themselves
          </Link>
        }
      />

      <p className="mb-4 text-sm text-[var(--color-text-muted)]" data-activity-summary>
        {describeApiActivity(log.summary)}
      </p>

      {log.summary.requests > 0 && (
        <div className="mb-5 grid gap-3 sm:grid-cols-4">
          <StatCard label="Requests" value={log.summary.requests} hint="In the last day." />
          <StatCard
            label="Refused"
            value={log.summary.refused}
            hint="The caller can fix these."
          />
          <StatCard label="Failed" value={log.summary.failed} hint="These are ours." />
          <StatCard
            label="Typical answer"
            value={
              log.summary.averageDurationMs === null
                ? '—'
                : describeDuration(log.summary.averageDurationMs)
            }
            hint={
              log.summary.slowestDurationMs === null
                ? 'Nothing measured yet.'
                : `Slowest ${describeDuration(log.summary.slowestDurationMs)}.`
            }
          />
        </div>
      )}

      <div className="mb-5 flex flex-wrap gap-2 text-sm" data-activity-filters>
        <FilterLink label="Everything" href="/settings/api-activity" active={!params.status} />
        <FilterLink
          label="Refused only"
          href="/settings/api-activity?status=client_error"
          active={params.status === 'client_error'}
        />
        <FilterLink
          label="Failed only"
          href="/settings/api-activity?status=server_error"
          active={params.status === 'server_error'}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <div className="flex flex-col gap-5">
          {refused.length > 0 && (
            <Card
              title="Not answered the way the caller wanted"
              description="A refusal names what to change; a failure is ours to fix."
            >
              <ul className="flex flex-col divide-y divide-[var(--color-border)]/60">
                {refused.slice(0, 10).map((row) => (
                  <li key={row.id} className="py-2 text-sm" data-refusal={row.id}>
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${STATUS_CLASS_CLASSES[statusClass(row.statusCode)]}`}
                    >
                      {row.statusCode} {row.errorCode ?? ''}
                    </span>{' '}
                    <code className="text-xs">
                      {row.method} {row.path}
                    </code>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {' '}
                      · {row.apiKey?.name ?? 'a deleted key'} · {relativeWhen(row.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card
            title="The requests"
            description="Newest first. The query string is deliberately not stored — it carries names and numbers, and this screen is not behind lead:read."
          >
            {log.items.length === 0 ? (
              <EmptyState
                title="Nothing yet"
                description="Make a request with one of your keys and it appears here, whether we answered it or refused it."
              />
            ) : (
              <ul className="flex flex-col divide-y divide-[var(--color-border)]/60">
                {log.items.map((row) => (
                  <li key={row.id} className="py-2 text-sm" data-request={row.id}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div>
                        <span
                          className={`rounded px-2 py-0.5 text-xs ${STATUS_CLASS_CLASSES[statusClass(row.statusCode)]}`}
                          data-request-status={row.id}
                        >
                          {STATUS_CLASS_LABELS[statusClass(row.statusCode)]} {row.statusCode}
                        </span>{' '}
                        <code className="text-xs" data-request-path={row.id}>
                          {row.method} {row.path}
                        </code>
                      </div>
                      <span className="text-xs text-[var(--color-text-muted)]">
                        {describeDuration(row.durationMs)} · {relativeWhen(row.createdAt)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                      {row.apiKey?.name ?? 'a deleted key'} · {SURFACE_LABELS[row.surface]}
                      {row.ip ? ` · from ${row.ip}` : ''} ·{' '}
                      <code>{row.requestId}</code>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <Card
            title="Your keys"
            description="What each one has been doing. A key with no requests is either unused or pointed somewhere else."
          >
            {keys.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                No keys yet.{' '}
                <Link href="/settings/api-keys" className="underline">
                  Create one
                </Link>
                .
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-[var(--color-border)]/60">
                {keys.map((apiKey) => (
                  <li key={apiKey.id} className="py-2 text-sm" data-key-usage={apiKey.id}>
                    <p className="font-medium" data-key-usage-name={apiKey.id}>
                      {apiKey.name}
                    </p>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      <code>{apiKey.keyPrefix}…</code> ·{' '}
                      {describeKeyUsage(usageByKey.get(apiKey.id))}
                    </p>
                    <Link
                      href={`/settings/api-activity?key=${apiKey.id}`}
                      className="text-xs underline"
                    >
                      Only this key
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card
            title="What is not here"
            description="On purpose, and worth knowing before you go looking."
          >
            <ul className="flex flex-col gap-2 text-sm text-[var(--color-text-muted)]">
              <li>
                <strong>No bodies.</strong> What a request sent and what we sent back are not
                stored. A lead captured through the public endpoint keeps its payload on{' '}
                <Link href="/ingestion" className="underline">
                  the integration log
                </Link>
                , where reading it needs the permission to read leads.
              </li>
              <li>
                <strong>No session traffic.</strong> This app’s own requests are not here — it would
                be a hundred times the rows for the one caller that can already see everything.
              </li>
              <li>
                <strong>Thirty days.</strong> A whole day is dropped at a time, which is why the
                table is partitioned by day.
              </li>
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

function FilterLink({
  label,
  href,
  active,
}: {
  label: string;
  href: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1 ${
        active
          ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
          : 'border-[var(--color-border)]'
      }`}
      data-filter-active={active ? 'true' : 'false'}
    >
      {label}
    </Link>
  );
}
