import Link from 'next/link';
import { describeError } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Card, EmptyState, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import { relativeWhen } from '@/lib/forms';
import {
  DELIVERY_STATUS_CLASSES,
  DELIVERY_STATUS_LABELS,
  EVENT_LABELS,
  describeDelivery,
  describeWebhooks,
  loadWebhookDeliveries,
  loadWebhookEndpoints,
  verificationSnippet,
  type WebhookDeliveryRow,
  type WebhookEndpointRecord,
  type WebhookEventType,
} from '@/lib/webhooks';
import {
  NewWebhookEndpointForm,
  RetryDeliveryButton,
  WebhookEndpointRow,
} from './_components/webhook-forms';

/**
 * Where this workspace's events go (`FR-API-4`).
 *
 * Behind `webhook:manage`, which has been in the catalogue since Phase 1 with nothing reading it.
 * There is no read-only view: a delivery's payload carries the event's own data, and somebody who
 * may read that may already read the lead it is about.
 *
 * The order is the order somebody uses it: the endpoints, then what has been sent, then the code
 * their server needs to verify a delivery — which is on the screen rather than in a document
 * because the one thing that makes a receiving endpoint unsafe is trusting a payload without
 * checking its signature.
 *
 * Read through the **throwing** loaders: on a screen whose job is to list endpoints, a swallowed
 * failure would say "none yet" to a workspace whose integration is live, and the obvious next
 * action from that screen is to create a second one.
 */
export const dynamic = 'force-dynamic';

export default async function WebhooksPage() {
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  if (!can(user, 'webhook:manage')) {
    return (
      <>
        <PageHeader title="Outbound webhooks" />
        <ErrorNotice>Your role does not include this workspace’s webhooks.</ErrorNotice>
      </>
    );
  }

  let endpoints: WebhookEndpointRecord[];
  let deliveries: { items: WebhookDeliveryRow[]; total: number };
  try {
    [endpoints, deliveries] = await Promise.all([
      loadWebhookEndpoints(token),
      loadWebhookDeliveries(token, '?limit=25'),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="Outbound webhooks" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  const live = endpoints.filter((endpoint) => endpoint.isActive);
  const stopped = endpoints.filter(
    (endpoint) =>
      !endpoint.isActive &&
      endpoint.disabledReason !== null &&
      !endpoint.disabledReason.startsWith('Switched off by'),
  );
  const unfinished = deliveries.items.filter(
    (row) => row.status === 'failed' || row.status === 'exhausted',
  );

  return (
    <>
      <PageHeader
        title="Outbound webhooks"
        description="When something happens here, we post it to your own server — signed, retried, and logged attempt by attempt."
        action={
          <Link href="/settings/api-keys" className="text-sm underline">
            Posting leads in instead?
          </Link>
        }
      />

      <p className="mb-4 text-sm text-[var(--color-text-muted)]" data-webhooks-summary>
        {describeWebhooks({
          endpoints: endpoints.length,
          live: live.length,
          failing: stopped.length,
        })}
      </p>

      {endpoints.length > 0 && (
        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          <StatCard
            label="Endpoints"
            value={endpoints.length}
            hint={`${live.length} of them live.`}
          />
          <StatCard
            label="Recent deliveries"
            value={deliveries.total}
            hint="Every attempt is kept."
          />
          <StatCard
            label="Not delivered"
            value={unfinished.length}
            hint="Each one can be sent again."
          />
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <div className="flex flex-col gap-5">
          <Card
            title="Your endpoints"
            description="Rotating the secret keeps the endpoint and changes what signs it. Switching one off stops everything at once."
          >
            {endpoints.length === 0 ? (
              <EmptyState
                title="Nothing is listening yet"
                description="Add your server’s address, choose the events it cares about, and we will post each one as it happens — with fifteen minutes of retries behind it."
              />
            ) : (
              <div className="flex flex-col">
                {endpoints.map((endpoint) => (
                  <WebhookEndpointRow key={endpoint.id} endpoint={endpoint} />
                ))}
              </div>
            )}
          </Card>

          <Card
            title="What we have sent"
            description="At-least-once, so deduplicate on the event id. Every attempt is here, with what your server answered."
          >
            {deliveries.items.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                Nothing yet. Send a test from an endpoint above, or wait for one of its events to
                happen.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-[var(--color-border)]/60">
                {deliveries.items.map((row) => (
                  <li key={row.id} className="py-3 text-sm" data-delivery={row.id}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p>
                          <span
                            className={`rounded px-2 py-0.5 text-xs ${DELIVERY_STATUS_CLASSES[row.status]}`}
                            data-delivery-status={row.id}
                          >
                            {DELIVERY_STATUS_LABELS[row.status]}
                          </span>{' '}
                          {EVENT_LABELS[row.eventType as WebhookEventType] ?? row.eventType}{' '}
                          <code className="text-xs text-[var(--color-text-muted)]">
                            {row.eventType}
                          </code>
                        </p>
                        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                          {row.endpoint?.url ?? 'a deleted endpoint'} ·{' '}
                          {describeDelivery(row)} · {relativeWhen(row.createdAt)}
                        </p>
                        {row.lastResponseBody && (
                          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                            Your server said:{' '}
                            <code data-delivery-response={row.id}>{row.lastResponseBody}</code>
                          </p>
                        )}
                      </div>
                      {row.status !== 'succeeded' && row.status !== 'pending' && (
                        <RetryDeliveryButton deliveryId={row.id} />
                      )}
                    </div>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-[var(--color-text-muted)]">
                        The body we signed
                      </summary>
                      <pre
                        className="mt-1 overflow-x-auto rounded-md bg-[var(--color-surface-muted)] p-3 text-xs"
                        data-delivery-body={row.id}
                      >
                        {JSON.stringify(row.payload ?? {}, null, 2)}
                      </pre>
                      {row.attempts.length > 0 && (
                        <ul className="mt-1 flex flex-col gap-0.5 text-xs text-[var(--color-text-muted)]">
                          {row.attempts.map((attempt) => (
                            <li key={attempt.attemptNo} data-delivery-attempt={row.id}>
                              Attempt {attempt.attemptNo}:{' '}
                              {attempt.statusCode === null
                                ? (attempt.error ?? 'no answer')
                                : `HTTP ${attempt.statusCode}`}{' '}
                              in {attempt.durationMs} ms, {relativeWhen(attempt.attemptedAt)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <Card title="Add an endpoint" description="The signing secret is shown once, here.">
            <NewWebhookEndpointForm />
          </Card>

          <Card
            title="Checking a delivery is really from us"
            description="Every request carries X-LeadOS-Timestamp and X-LeadOS-Signature. Verify both before you trust the body."
          >
            <pre
              className="overflow-x-auto rounded-md bg-[var(--color-surface-muted)] p-3 text-xs"
              data-verification-snippet
            >
              {verificationSnippet()}
            </pre>
            <p className="mt-3 text-sm text-[var(--color-text-muted)]">
              Answer any 2xx and we stop retrying. Answer <code>410 Gone</code> and we switch the
              endpoint off immediately. Anything else is retried at 10 s, 1 m, 5 m, 30 m, 2 h, 6 h
              and 24 h, and after fifteen failures in a row we stop and tell you.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
