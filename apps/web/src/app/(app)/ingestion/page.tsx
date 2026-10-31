import Link from 'next/link';
import { describeError } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Card, EmptyState, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import { relativeWhen } from '@/lib/forms';
import {
  CHANNEL_LABELS,
  PAYLOAD_STATUS_CLASSES,
  PAYLOAD_STATUS_LABELS,
  STAGE_LABELS,
  describeIngestion,
  loadIngestionErrors,
  loadPayloads,
  loadUnmappedFields,
  type IngestionErrorRow,
  type PayloadRow,
  type UnmappedField,
} from '@/lib/ingestion';
import { IngestionTestTool, ReplayButton, UnmappedFieldRow } from './_components/ingestion-panels';

/**
 * What arrived through the lead API, and what became of it (`FR-CAP-3`, `FR-CAP-5`, `FR-CAP-6`).
 *
 * Four things on one screen, in the order somebody debugging an integration needs them: the test
 * tool (before anything is live), the failures (the only rows anybody has to act on), the fields
 * nowhere to put, and then the log itself. A screen that led with the log would bury the handful of
 * rows that matter under the hundreds that worked — the same argument the forms screen makes for
 * showing refused submissions above the forms.
 *
 * Behind `api_key:manage`: these are request bodies from the workspace's own integrations, which is
 * developer-facing material rather than lead data.
 */
export const dynamic = 'force-dynamic';

export default async function IngestionPage() {
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  if (!can(user, 'api_key:manage')) {
    return (
      <>
        <PageHeader title="Integration log" />
        <ErrorNotice>Your role does not include this workspace’s integrations.</ErrorNotice>
      </>
    );
  }

  let payloads: { items: PayloadRow[]; total: number };
  let failures: IngestionErrorRow[];
  let unmapped: { items: UnmappedField[]; payloadsScanned: number };
  try {
    [payloads, failures, unmapped] = await Promise.all([
      loadPayloads(token, '?limit=25'),
      loadIngestionErrors(token, '?limit=10'),
      loadUnmappedFields(token),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="Integration log" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  const unfinished = payloads.items.filter(
    (row) => row.status === 'failed' || row.status === 'received',
  );

  return (
    <>
      <PageHeader
        title="Integration log"
        description="Every payload posted to the lead API is stored before anything is attempted — so a lead that failed to be created is still here, and can be finished."
        action={
          <Link href="/settings/api-keys" className="text-sm underline">
            Keys and the request to make
          </Link>
        }
      />

      <p className="mb-4 text-sm text-[var(--color-text-muted)]" data-ingestion-summary>
        {describeIngestion({
          total: payloads.total,
          failed: unfinished.length,
          unmappedFields: unmapped.items.length,
        })}
      </p>

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Payloads stored"
          value={payloads.total}
          hint="Nothing is ever discarded."
        />
        <StatCard
          label="Not yet leads"
          value={unfinished.length}
          hint="Each one can be tried again."
        />
        <StatCard
          label="Fields with no home"
          value={unmapped.items.length}
          hint={`Across the last ${unmapped.payloadsScanned} payloads.`}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <div className="flex flex-col gap-5">
          {unfinished.length > 0 && (
            <Card
              title="Payloads that did not become leads"
              description="Stored, and finishable: a crash mid-ingestion leaves a payload here rather than losing the enquiry."
            >
              <ul className="flex flex-col divide-y divide-[var(--color-border)]/60">
                {unfinished.map((row) => (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-start justify-between gap-3 py-3"
                    data-unfinished={row.id}
                  >
                    <div className="text-sm">
                      <p>
                        <span
                          className={`rounded px-2 py-0.5 text-xs ${PAYLOAD_STATUS_CLASSES[row.status]}`}
                        >
                          {PAYLOAD_STATUS_LABELS[row.status]}
                        </span>{' '}
                        {row.apiKey?.name ?? 'An integration'} · {relativeWhen(row.receivedAt)}
                      </p>
                      <p className="mt-1 text-[var(--color-text-muted)]">
                        {row.errors[0]
                          ? `${STAGE_LABELS[row.errors[0].stage as keyof typeof STAGE_LABELS] ?? row.errors[0].stage} — ${row.errors[0].message}`
                          : (row.error ??
                            'Stored before anything was attempted, and never finished.')}
                      </p>
                      {row.attempts > 1 && (
                        <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                          {row.attempts} attempts so far.
                        </p>
                      )}
                    </div>
                    <ReplayButton payloadId={row.id} />
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card
            title="Fields nobody has a home for"
            description="Kept rather than refused, every time — and one click away from being a field on every lead."
          >
            {unmapped.items.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                Everything that has arrived mapped onto something. Nothing to decide.
              </p>
            ) : (
              <div className="flex flex-col">
                {unmapped.items.map((field) => (
                  <UnmappedFieldRow
                    key={field.field}
                    field={field}
                    canCreateFields={can(user, 'custom_field:manage')}
                  />
                ))}
              </div>
            )}
          </Card>

          <Card
            title="What has arrived"
            description="The body as it was sent, byte for byte — which is what makes “we did receive it” answerable."
          >
            {payloads.items.length === 0 ? (
              <EmptyState
                title="Nothing has been posted yet"
                description="Create a key, sign a request, and the first payload appears here — whether or not it became a lead."
                action={
                  <Link href="/settings/api-keys" className="text-sm underline">
                    Create a key
                  </Link>
                }
              />
            ) : (
              <ul className="flex flex-col divide-y divide-[var(--color-border)]/60">
                {payloads.items.map((row) => (
                  <li key={row.id} className="py-3 text-sm" data-payload={row.id}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span>
                        <span
                          className={`rounded px-2 py-0.5 text-xs ${PAYLOAD_STATUS_CLASSES[row.status]}`}
                          data-payload-status={row.id}
                        >
                          {PAYLOAD_STATUS_LABELS[row.status]}
                        </span>{' '}
                        {CHANNEL_LABELS[row.channel as keyof typeof CHANNEL_LABELS] ?? row.channel}
                        {row.apiKey ? ` · ${row.apiKey.name}` : ''}
                      </span>
                      <span className="text-[var(--color-text-muted)]">
                        {relativeWhen(row.receivedAt)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                      {row.leadId ? (
                        <Link href={`/leads/${row.leadId}`} className="underline">
                          Open the lead it became
                        </Link>
                      ) : (
                        'No lead yet.'
                      )}
                      {row.idempotencyKey ? ` · key ${row.idempotencyKey}` : ''}
                      {row.unmappedFields.length > 0
                        ? ` · extra: ${row.unmappedFields.join(', ')}`
                        : ''}
                    </p>
                    {row.replayedAt !== null && (
                      <p
                        className="mt-0.5 text-xs text-[var(--color-text-muted)]"
                        data-payload-replayed={row.id}
                      >
                        Tried again {relativeWhen(row.replayedAt)} —{' '}
                        {row.status === 'processed'
                          ? 'it became a lead.'
                          : row.status === 'duplicate'
                            ? 'it was added to an existing lead.'
                            : 'and it still did not go through.'}
                      </p>
                    )}
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-[var(--color-text-muted)]">
                        The payload as sent
                      </summary>
                      <pre
                        className="mt-1 overflow-x-auto rounded-md bg-[var(--color-surface-muted)] p-3 text-xs"
                        data-payload-body={row.id}
                      >
                        {JSON.stringify(row.body ?? {}, null, 2)}
                      </pre>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <Card
            title="Try a payload"
            description="Before anything is live, and without saving a thing."
          >
            <IngestionTestTool />
          </Card>

          {failures.length > 0 && (
            <Card
              title="Recent failures by stage"
              description="Named by the step that refused it, because a stage is something a tenant can act on and a stack trace is not."
            >
              <ul className="flex flex-col divide-y divide-[var(--color-border)]/60">
                {failures.map((failure) => (
                  <li key={failure.id} className="py-2 text-sm" data-failure={failure.id}>
                    <p data-failure-stage={failure.id}>
                      {STAGE_LABELS[failure.stage as keyof typeof STAGE_LABELS] ?? failure.stage}
                    </p>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      {failure.message} · {relativeWhen(failure.createdAt)}
                      {failure.isReplayable ? '' : ' · re-running it will not help'}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
