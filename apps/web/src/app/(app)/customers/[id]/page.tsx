import Link from 'next/link';
import { describeError } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Badge, Card, DefinitionRow, ErrorNotice, PageHeader } from '@/components/ui';
import { Timeline } from '@/components/timeline';
import { formatDate, formatDateTime } from '@/lib/lead-format';
import { loadCustomer, loadJourney, type CustomerDetail } from '@/lib/customers';
import type { TimelineEntryLike } from '@/lib/timeline-registry';
import {
  CustomerDetailsForm,
  DeleteCustomerButton,
  RestoreCustomerButton,
} from '../_components/customer-forms';

/**
 * A customer, and the whole journey that produced them (`FR-DEAL-4`).
 *
 * The journey is the reason this screen exists rather than being a row in a list: the ad, the form,
 * the three follow-up calls and the conversion are one history, and the API returns them as one
 * list. The entries from before the conversion are marked, so the handover is visible without being
 * a second timeline.
 */
export const dynamic = 'force-dynamic';

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  let customer: CustomerDetail;
  try {
    customer = await loadCustomer(id, token);
  } catch (error) {
    return (
      <>
        <PageHeader title="Customer" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  let journey: TimelineEntryLike[] = [];
  let journeyError: string | null = null;
  try {
    journey = await loadJourney(id, token);
  } catch (error) {
    journeyError = describeError(error);
  }

  const active = tab === 'details' ? 'details' : 'journey';
  const editable = can(user, 'customer:manage');

  return (
    <>
      <PageHeader
        title={customer.fullName}
        description={[customer.company, customer.jobTitle].filter(Boolean).join(' · ') || undefined}
        action={
          <div className="flex items-center gap-3">
            {customer.deletedAt ? (
              <Badge tone="danger">Deleted</Badge>
            ) : customer.converted ? (
              <Badge tone="success">Converted customer</Badge>
            ) : (
              <Badge>Entered directly</Badge>
            )}
            <Link href="/customers" className="text-sm underline">
              All customers
            </Link>
          </div>
        }
      />

      {customer.deletedAt && (
        <div className="mb-4">
          <ErrorNotice>
            This customer was deleted on {formatDateTime(customer.deletedAt)}. Their history is
            intact.
          </ErrorNotice>
          {editable && (
            <div className="mt-3">
              <RestoreCustomerButton id={customer.id} />
            </div>
          )}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-4">
          <nav className="flex gap-1 border-b border-[var(--color-border)]" aria-label="Sections">
            {(
              [
                ['journey', 'Journey'],
                ['details', 'Details'],
              ] as const
            ).map(([key, label]) => (
              <Link
                key={key}
                href={`/customers/${customer.id}${key === 'journey' ? '' : `?tab=${key}`}`}
                aria-current={active === key ? 'page' : undefined}
                className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                  active === key
                    ? 'border-[var(--color-primary)] font-medium'
                    : 'border-transparent text-[var(--color-text-muted)]'
                }`}
              >
                {label}
              </Link>
            ))}
          </nav>

          {active === 'journey' ? (
            <Card
              title="The whole journey"
              description={
                customer.origin
                  ? `Everything from the first capture on ${formatDate(customer.origin.capturedAt)} to today — the lead’s history and the customer’s, in one list.`
                  : 'Everything recorded against this customer.'
              }
            >
              {journeyError ? (
                <ErrorNotice>{journeyError}</ErrorNotice>
              ) : journey.length === 0 ? (
                <p className="text-sm text-[var(--color-text-muted)]">Nothing recorded yet.</p>
              ) : (
                <Timeline entries={journey} now={new Date().toISOString()} />
              )}
            </Card>
          ) : (
            <Card title="Account details">
              {editable ? (
                <CustomerDetailsForm
                  id={customer.id}
                  initial={{
                    firstName: customer.firstName ?? '',
                    lastName: customer.lastName ?? '',
                    company: customer.company ?? '',
                    jobTitle: customer.jobTitle ?? '',
                    phone: customer.phone ?? '',
                    email: customer.email ?? '',
                    billingLine1: customer.billing.line1 ?? '',
                    city: customer.billing.city ?? '',
                    state: customer.billing.state ?? '',
                    postalCode: customer.billing.postalCode ?? '',
                    country: customer.billing.country ?? '',
                    taxId: customer.billing.taxId ?? '',
                  }}
                />
              ) : (
                <dl className="flex flex-col">
                  <DefinitionRow label="Phone">{customer.phone ?? '—'}</DefinitionRow>
                  <DefinitionRow label="Email">{customer.email ?? '—'}</DefinitionRow>
                  <DefinitionRow label="Address">
                    {[customer.billing.line1, customer.billing.city, customer.billing.postalCode]
                      .filter(Boolean)
                      .join(', ') || '—'}
                  </DefinitionRow>
                  <DefinitionRow label="GSTIN / tax id">
                    {customer.billing.taxId ?? '—'}
                  </DefinitionRow>
                </dl>
              )}
            </Card>
          )}
        </div>

        <aside className="flex flex-col gap-4">
          {customer.origin && (
            <Card title="Where they came from">
              <dl className="flex flex-col">
                <DefinitionRow label="Captured">
                  {formatDate(customer.origin.capturedAt)}
                </DefinitionRow>
                <DefinitionRow label="Source">{customer.origin.source ?? '—'}</DefinitionRow>
                <DefinitionRow label="Score when converted">
                  {customer.origin.scoreBand
                    ? `${customer.origin.scoreAtConversion} · ${customer.origin.scoreBand}`
                    : customer.origin.scoreAtConversion}
                </DefinitionRow>
                <DefinitionRow label="Original lead">
                  <Link href={`/leads/${customer.origin.leadId}`} className="underline">
                    {customer.origin.leadName}
                  </Link>
                </DefinitionRow>
              </dl>
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                The lead is still there, marked converted. Nothing was copied or moved.
              </p>
            </Card>
          )}

          <Card title="Account">
            <dl className="flex flex-col">
              <DefinitionRow label="Account manager">
                {customer.owner?.name ?? 'Nobody'}
              </DefinitionRow>
              <DefinitionRow label="Branch">{customer.branch?.name ?? '—'}</DefinitionRow>
              <DefinitionRow label="Team">{customer.team?.name ?? '—'}</DefinitionRow>
              <DefinitionRow label="Customer since">
                {formatDate(customer.convertedAt ?? customer.createdAt)}
              </DefinitionRow>
            </dl>
          </Card>

          <Card
            title="Consent"
            description="Carried over from the lead, and theirs to change at any time."
          >
            <dl className="flex flex-col">
              <DefinitionRow label="WhatsApp">
                {customer.consent.whatsapp ? 'Given' : 'Not on record'}
              </DefinitionRow>
              <DefinitionRow label="Email">
                {customer.consent.email ? 'Given' : 'Not on record'}
              </DefinitionRow>
              <DefinitionRow label="Calls">
                {customer.consent.calls ? 'Given' : 'Not on record'}
              </DefinitionRow>
            </dl>
          </Card>

          {editable && !customer.deletedAt && (
            <Card title="Danger zone">
              <DeleteCustomerButton id={customer.id} />
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                Reversible. The customer moves to the recycle bin with their history intact.
              </p>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}
