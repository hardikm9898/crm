import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, describeError, request } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Badge, Button, Card, EmptyState, ErrorNotice } from '@/components/ui';
import {
  bandFor,
  bandTone,
  formatDate,
  formatDateTime,
  formatMoney,
  formatPhone,
  initials,
  priorityTone,
  relativeTime,
  statusTone,
  telHref,
  whatsappHref,
} from '@/lib/lead-format';
import { humanise } from '@/lib/timeline-registry';
import type { TimelineEntryLike } from '@/lib/timeline-registry';
import {
  loadMembers,
  loadOptions,
  type DuplicatePair,
  type LeadDetail,
  type PipelineSummary,
  type ScoreBreakdown,
} from '@/lib/leads';
import { Timeline } from '@/components/timeline';
import { ConvertForm } from '../../customers/_components/convert-form';
import {
  OwnerControl,
  RecomputeScoreButton,
  StageControl,
  StatusControl,
  TagsControl,
} from './_components/lead-controls';
import {
  DeleteLeadButton,
  DuplicateBanner,
  EditLeadForm,
  TouchpointForm,
} from './_components/lead-panels';

/**
 * Lead detail (`FR-LEAD`, docs/frontend-architecture.md §5.2).
 *
 * Three regions on desktop — identity, the tabbed centre, and the controls rail — stacked on a
 * phone, in that order, because on 375 px the first thing wanted is who this is and how to reach
 * them (`NFR-UX-1`).
 *
 * Tabs are URL state (`?tab=`), not client state: a timeline someone scrolled to is a link they can
 * send, and the back button does what it looks like it does.
 */
export const dynamic = 'force-dynamic';

type Tab = 'overview' | 'timeline' | 'edit';

export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab: requestedTab } = await searchParams;
  const tab: Tab =
    requestedTab === 'timeline' || requestedTab === 'edit' ? requestedTab : 'overview';

  const user = await requireCurrentUser();
  const token = await readAccessToken();

  let lead: LeadDetail;
  try {
    const response = await request<LeadDetail>(`/leads/${id}`, { token });
    lead = response.data;
  } catch (error) {
    // 404 covers both "no such lead" and "not yours to see" — the API answers the same way on
    // purpose, and this page must not distinguish them either.
    if (error instanceof ApiError && error.status === 404) notFound();
    return (
      <Card>
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </Card>
    );
  }

  const [
    statuses,
    sources,
    lostReasons,
    tags,
    members,
    pipelines,
    timeline,
    breakdown,
    duplicates,
  ] = await Promise.all([
    loadOptions('/crm/statuses', token),
    loadOptions('/crm/sources', token),
    loadOptions('/crm/lost-reasons', token),
    loadOptions('/crm/tags', token),
    loadMembers(token),
    loadPipelines(token),
    loadTimeline(id, token),
    loadBreakdown(id, token),
    loadDuplicates(id, token),
  ]);

  const pipeline = pipelines.find((entry) => entry.id === lead.pipelineId);
  const band = lead.scoreBand
    ? breakdown?.bands.find((entry) => entry.name === lead.scoreBand)
    : bandFor(lead.score, breakdown?.bands ?? []);
  const owner = members.find((member) => member.userId === lead.assignedUserId);
  const source = sources.find((entry) => entry.id === lead.leadSourceId);
  const now = new Date().toISOString();
  const mayUpdate = can(user, 'lead:update');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/leads"
          className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          ← Leads
        </Link>
        {lead.deletedAt && <Badge tone="warning">In the recycle bin</Badge>}
      </div>

      {can(user, 'lead:merge') && (
        <DuplicateBanner
          leadId={lead.id}
          pairs={duplicates.map((pair) => ({
            id: pair.id,
            otherId: otherLeadId(pair, lead.id),
            otherName: otherLeadName(pair, lead.id),
            confidence: pair.confidence,
          }))}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-[20rem_1fr_17rem]">
        {/* ── Identity ─────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4">
          <Card>
            <div className="flex items-start gap-3">
              <span
                aria-hidden
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-muted)] text-sm font-semibold"
              >
                {initials(lead.fullName)}
              </span>
              <div className="min-w-0">
                <h1 className="text-lg font-semibold leading-tight">{lead.fullName}</h1>
                {lead.company && (
                  <p className="text-sm text-[var(--color-text-muted)]">
                    {lead.jobTitle ? `${lead.jobTitle}, ` : ''}
                    {lead.company}
                  </p>
                )}
              </div>
            </div>

            <dl className="mt-4 flex flex-col gap-2 text-sm">
              <ContactRow
                label="Phone"
                value={formatPhone(lead.phone)}
                href={telHref(lead.phone)}
              />
              <ContactRow
                label="WhatsApp"
                value={formatPhone(lead.whatsapp ?? lead.phone)}
                href={whatsappHref(lead.whatsapp ?? lead.phone)}
                external
              />
              <ContactRow
                label="Email"
                value={lead.email ?? '—'}
                href={lead.email ? `mailto:${lead.email}` : null}
              />
              <ContactRow
                label="Location"
                value={[lead.city, lead.state, lead.postalCode].filter(Boolean).join(', ') || '—'}
              />
            </dl>

            <div className="mt-4 flex flex-wrap gap-1.5">
              {source && <Badge>{source.name}</Badge>}
              <Badge>{humanise(lead.createdVia)}</Badge>
              {lead.priority !== 'medium' && (
                <Badge tone={priorityTone(lead.priority)}>{lead.priority}</Badge>
              )}
              {lead.tags.map((tag) => (
                <Badge key={tag.id}>{tag.name}</Badge>
              ))}
            </div>
          </Card>

          <Card title="Consent" description="What this person has agreed to be contacted on.">
            <ul className="flex flex-col gap-1.5 text-sm">
              {(
                [
                  ['WhatsApp', lead.consent.whatsapp],
                  ['Email', lead.consent.email],
                  ['Calls', lead.consent.calls],
                ] as const
              ).map(([channel, granted]) => (
                <li key={channel} className="flex items-center justify-between">
                  <span>{channel}</span>
                  <Badge tone={granted ? 'success' : 'neutral'}>
                    {granted ? 'Yes' : 'Not given'}
                  </Badge>
                </li>
              ))}
            </ul>
          </Card>

          <Card
            title="Attribution"
            description={`${lead.touchCount} enquir${lead.touchCount === 1 ? 'y' : 'ies'}`}
          >
            <ol className="flex flex-col gap-2 text-sm">
              {lead.touchpoints.map((touchpoint) => (
                <li key={touchpoint.id} className="flex items-baseline justify-between gap-2">
                  <span>
                    <span className="text-[var(--color-text-muted)]">{touchpoint.sequence}.</span>{' '}
                    {humanise(touchpoint.channel)}
                  </span>
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {relativeTime(touchpoint.occurredAt, new Date(now))}
                  </span>
                </li>
              ))}
            </ol>
            {mayUpdate && (
              <div className="mt-3 border-t border-[var(--color-border)] pt-3">
                <TouchpointForm leadId={lead.id} sources={sources} />
              </div>
            )}
          </Card>
        </div>

        {/* ── Centre: tabs ─────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4">
          <nav
            aria-label="Lead sections"
            className="flex gap-1 border-b border-[var(--color-border)]"
          >
            {(
              [
                ['overview', 'Overview'],
                ['timeline', 'Timeline'],
                ...(mayUpdate ? ([['edit', 'Edit']] as const) : []),
              ] as const
            ).map(([value, label]) => (
              <Link
                key={value}
                href={`/leads/${lead.id}?tab=${value}`}
                aria-current={tab === value ? 'page' : undefined}
                className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                  tab === value
                    ? 'border-[var(--color-primary)] font-medium text-[var(--color-primary)]'
                    : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                }`}
              >
                {label}
              </Link>
            ))}
          </nav>

          {tab === 'overview' && (
            <>
              <Card title="At a glance">
                <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  <Detail label="Value">{formatMoney(lead.valueMinor, lead.currency)}</Detail>
                  <Detail label="Pipeline">{lead.pipeline?.name ?? '—'}</Detail>
                  <Detail label="Captured">{formatDateTime(lead.createdAt)}</Detail>
                  <Detail label="Last activity">
                    {relativeTime(lead.lastActivityAt ?? lead.createdAt, new Date(now))}
                  </Detail>
                  <Detail label="First contacted">{formatDateTime(lead.firstContactedAt)}</Detail>
                  <Detail label="Next action">
                    {lead.nextActionAt ? formatDateTime(lead.nextActionAt) : 'Nothing scheduled'}
                  </Detail>
                  {lead.lostReason && <Detail label="Lost reason">{lead.lostReason.name}</Detail>}
                  {lead.lostNote && <Detail label="Lost note">{lead.lostNote}</Detail>}
                </dl>
              </Card>

              <CustomFieldsCard lead={lead} />

              <Card
                title="Recent activity"
                action={
                  <Link
                    href={`/leads/${lead.id}?tab=timeline`}
                    className="text-sm text-[var(--color-primary)]"
                  >
                    Full timeline
                  </Link>
                }
              >
                {timeline.length === 0 ? (
                  <EmptyState title="Nothing recorded yet" />
                ) : (
                  <Timeline entries={timeline.slice(0, 6)} now={now} />
                )}
              </Card>
            </>
          )}

          {tab === 'timeline' && (
            <Card title="Everything that has happened" description="Newest first.">
              {timeline.length === 0 ? (
                <EmptyState title="Nothing recorded yet" />
              ) : (
                <Timeline entries={timeline} now={now} />
              )}
            </Card>
          )}

          {tab === 'edit' && mayUpdate && (
            <Card
              title="Edit details"
              description="Transitions have their own controls on the right."
            >
              <EditLeadForm lead={lead} />
            </Card>
          )}
        </div>

        {/* ── Controls rail ────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4">
          <Card>
            <div className="flex flex-col gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                  Score
                </p>
                <p className="mt-1 flex items-baseline gap-2">
                  <span className="numeric text-2xl font-semibold">{lead.score}</span>
                  {band && <Badge tone={bandTone(band, breakdown?.bands ?? [])}>{band.name}</Badge>}
                </p>
                {breakdown && breakdown.contributions.length > 0 && (
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer text-[var(--color-primary)]">Why?</summary>
                    <ul className="mt-2 flex flex-col gap-1">
                      {breakdown.contributions.map((contribution) => (
                        <li
                          key={`${contribution.ruleId ?? contribution.label}`}
                          className="flex items-baseline justify-between gap-2"
                        >
                          <span className="text-[var(--color-text-muted)]">
                            {contribution.label}
                            {contribution.times > 1 ? ` ×${contribution.times}` : ''}
                          </span>
                          <span className="numeric">
                            {contribution.total > 0 ? '+' : ''}
                            {contribution.total}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {!breakdown.addsUp && (
                      <p className="mt-2 text-xs text-[var(--color-warning)]">
                        These do not add up to the score shown. Recalculate to fix it.
                      </p>
                    )}
                  </details>
                )}
                {breakdown && breakdown.contributions.length === 0 && (
                  <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                    No scoring rule has applied yet.
                  </p>
                )}
                {mayUpdate && <RecomputeScoreButton leadId={lead.id} />}
              </div>

              <div className="border-t border-[var(--color-border)] pt-4">
                <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
                  Now
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Badge tone={statusTone(lead.status.category)}>{lead.status.name ?? '—'}</Badge>
                  <Badge>{lead.stage.name ?? '—'}</Badge>
                </p>
                <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                  {owner ? `Owned by ${owner.name}` : 'In the unassigned pool'}
                </p>
              </div>
            </div>
          </Card>

          {/* Conversion is `customer:manage`, not `lead:update`: creating a customer is what it
              does, and a workspace may well let somebody work leads without opening accounts. */}
          {can(user, 'customer:manage') &&
            !lead.deletedAt &&
            (lead.convertedAt ? (
              <Card title="Already a customer">
                <p className="text-sm">
                  Converted on {formatDate(lead.convertedAt)}.{' '}
                  <Link href="/customers" className="underline">
                    Find them in customers
                  </Link>
                  .
                </p>
              </Card>
            ) : (
              <Card title="Won the sale?">
                <ConvertForm leadId={lead.id} />
              </Card>
            ))}

          {mayUpdate && (
            <Card title="Move this lead">
              <div className="flex flex-col gap-4">
                <StatusControl
                  leadId={lead.id}
                  statuses={statuses}
                  currentStatusId={lead.status.id}
                  lostReasons={lostReasons}
                />
                {pipeline && (
                  <StageControl
                    leadId={lead.id}
                    stages={pipeline.stages.map((stage) => ({
                      id: stage.id,
                      name: stage.name,
                      requiredFields: stage.requiredFields,
                    }))}
                    currentStageId={lead.stage.id}
                  />
                )}
                {can(user, 'lead:assign') && (
                  <OwnerControl
                    leadId={lead.id}
                    members={members.map((member) => ({
                      userId: member.userId,
                      name: member.name,
                    }))}
                    currentUserId={lead.assignedUserId}
                  />
                )}
                <TagsControl
                  leadId={lead.id}
                  tags={tags}
                  selected={lead.tags.map((tag) => tag.id)}
                />
              </div>
            </Card>
          )}

          <Card title="Reach them">
            <div className="flex flex-wrap gap-2">
              {telHref(lead.phone) ? (
                <a href={telHref(lead.phone)!}>
                  <Button variant="secondary">Call</Button>
                </a>
              ) : (
                <Button variant="secondary" disabled>
                  No phone number
                </Button>
              )}
              {whatsappHref(lead.whatsapp ?? lead.phone) && (
                <a
                  href={whatsappHref(lead.whatsapp ?? lead.phone)!}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Button variant="secondary">WhatsApp</Button>
                </a>
              )}
            </div>
            <p className="mt-2 text-xs text-[var(--color-text-muted)]">
              WhatsApp opens the official client. Sending from inside Lead OS arrives in Phase 5.
            </p>
          </Card>

          {can(user, 'lead:delete') && !lead.deletedAt && <DeleteLeadButton leadId={lead.id} />}
        </div>
      </div>
    </div>
  );
}

function ContactRow({
  label,
  value,
  href,
  external,
}: {
  label: string;
  value: string;
  href?: string | null;
  external?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">{label}</dt>
      <dd className="text-right">
        {href ? (
          <a
            href={href}
            {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
            className="text-[var(--color-primary)] hover:underline"
          >
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/**
 * Custom fields, grouped by the section the tenant put them in.
 *
 * Rendered from the definitions the API sends with the lead, so a field added a minute ago appears
 * here without a deploy (`FR-LEAD-6`). A value whose type this build does not recognise is shown as
 * text rather than hidden.
 */
function CustomFieldsCard({ lead }: { lead: LeadDetail }) {
  if (lead.fieldDefinitions.length === 0) return null;
  const sections = new Map<string, typeof lead.fieldDefinitions>();
  for (const definition of lead.fieldDefinitions) {
    const key = definition.sectionName ?? 'Details';
    sections.set(key, [...(sections.get(key) ?? []), definition]);
  }

  return (
    <Card title="Custom fields">
      <div className="flex flex-col gap-4">
        {[...sections.entries()].map(([section, definitions]) => (
          <div key={section}>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
              {section}
            </p>
            <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {definitions.map((definition) => (
                <Detail key={definition.id} label={definition.label}>
                  {renderCustomValue(lead.customValues[definition.key], definition.type)}
                </Detail>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Card>
  );
}

function renderCustomValue(value: unknown, type: string): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
  if (type === 'currency' && typeof value === 'object') {
    const record = value as { amountMinor?: unknown; currency?: unknown };
    if (typeof record.amountMinor === 'number') {
      return formatMoney(
        record.amountMinor,
        typeof record.currency === 'string' ? record.currency : 'INR',
      );
    }
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function otherLeadId(pair: DuplicatePair, leadId: string): string | null {
  if (pair.lead?.id && pair.lead.id !== leadId) return pair.lead.id;
  if (pair.duplicateLead?.id && pair.duplicateLead.id !== leadId) return pair.duplicateLead.id;
  return null;
}

function otherLeadName(pair: DuplicatePair, leadId: string): string {
  if (pair.lead?.id && pair.lead.id !== leadId) return pair.lead.fullName;
  if (pair.duplicateLead?.id && pair.duplicateLead.id !== leadId)
    return pair.duplicateLead.fullName;
  return 'another lead';
}

async function loadTimeline(id: string, token: string | null): Promise<TimelineEntryLike[]> {
  if (!token) return [];
  try {
    const response = await request<TimelineEntryLike[]>(`/leads/${id}/timeline?limit=50`, {
      token,
    });
    return response.data;
  } catch {
    return [];
  }
}

async function loadBreakdown(id: string, token: string | null): Promise<ScoreBreakdown | null> {
  if (!token) return null;
  try {
    const response = await request<ScoreBreakdown>(`/leads/${id}/score-breakdown`, { token });
    return response.data;
  } catch {
    return null;
  }
}

async function loadDuplicates(id: string, token: string | null): Promise<DuplicatePair[]> {
  if (!token) return [];
  try {
    const response = await request<DuplicatePair[]>(`/duplicates?leadId=${id}&status=open`, {
      token,
    });
    return response.data;
  } catch {
    // `lead:read` without `lead:merge` cannot list pairs, and that is not an error worth a banner.
    return [];
  }
}

async function loadPipelines(token: string | null): Promise<PipelineSummary[]> {
  if (!token) return [];
  try {
    const response = await request<PipelineSummary[]>('/crm/pipelines', { token });
    return response.data;
  } catch {
    return [];
  }
}
