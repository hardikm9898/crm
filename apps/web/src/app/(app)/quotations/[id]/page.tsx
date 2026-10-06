import Link from 'next/link';
import { describeError, request } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Badge, Card, DefinitionRow, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import { formatDate, formatDateTime, formatMoney } from '@/lib/lead-format';
import { loadProducts } from '@/lib/deals';
import {
  QUOTATION_STATUS_CLASSES,
  QUOTATION_STATUS_LABELS,
  loadQuotation,
  type QuotationDetail,
} from '@/lib/quotations';
import {
  DeleteQuotationButton,
  OutcomeForms,
  QuotationDetailsForm,
  QuotationLinesEditor,
  ReviseButton,
  SendQuotationForm,
} from '../_components/quotation-forms';

/**
 * One quotation — one **version** of one quotation.
 *
 * The screen changes shape with the status, because the document does: a draft is editable, a sent
 * version is a record of what the customer holds and can only be revised. That is not a UI
 * convention, it is the API's rule made visible, so nobody discovers it by being refused.
 */
export const dynamic = 'force-dynamic';

export default async function QuotationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  let quotation: QuotationDetail;
  try {
    quotation = await loadQuotation(id, token);
  } catch (error) {
    return (
      <>
        <PageHeader title="Quotation" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  const [products, lostReasons] = await Promise.all([loadProducts(token), loadLostReasons(token)]);

  const editable = can(user, 'deal:manage') && quotation.deletedAt === null;
  const isDraft = quotation.status === 'draft';
  const party = quotation.customer ?? quotation.lead;
  const partyHref = quotation.customer
    ? `/customers/${quotation.customer.id}`
    : quotation.lead
      ? `/leads/${quotation.lead.id}`
      : null;

  return (
    <>
      <PageHeader
        title={quotation.label}
        description={quotation.title ?? undefined}
        action={
          <div className="flex items-center gap-3">
            <span
              className={`inline-block rounded px-2 py-0.5 text-xs ${QUOTATION_STATUS_CLASSES[quotation.status]}`}
            >
              {QUOTATION_STATUS_LABELS[quotation.status]}
            </span>
            {!quotation.isCurrent && <Badge>Superseded</Badge>}
            <Link href={`/quotations/${quotation.id}/pdf`} className="text-sm underline">
              Open the PDF
            </Link>
            <Link href="/quotations" className="text-sm underline">
              All quotations
            </Link>
          </div>
        }
      />

      {quotation.deletedAt && (
        <div className="mb-4">
          <ErrorNotice>
            This draft was deleted on {formatDateTime(quotation.deletedAt)}.
          </ErrorNotice>
        </div>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatCard label="Total" value={formatMoney(quotation.totalMinor, quotation.currency)} />
        <StatCard
          label="Before tax"
          value={formatMoney(quotation.grossMinor, quotation.currency)}
        />
        <StatCard label="Tax" value={formatMoney(quotation.taxMinor, quotation.currency)} />
        <StatCard
          label="Valid until"
          value={quotation.validUntil ? formatDate(quotation.validUntil) : 'No expiry'}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-4">
          <Card
            title="What is being offered"
            description={
              isDraft
                ? 'Editable until it is sent. Tax is per line, because one quotation often mixes rates.'
                : 'Frozen. This is the document the customer holds; a change means a revision.'
            }
          >
            {editable && isDraft ? (
              <QuotationLinesEditor
                quotationId={quotation.id}
                items={quotation.items}
                products={products}
                currency={quotation.currency}
              />
            ) : (
              <FrozenLines quotation={quotation} />
            )}
          </Card>

          {isDraft && editable && (
            <Card
              title="The document"
              description="Title, validity and the terms printed at the foot."
            >
              <QuotationDetailsForm
                quotationId={quotation.id}
                title={quotation.title}
                terms={quotation.terms}
                validUntil={quotation.validUntil}
              />
            </Card>
          )}

          {!isDraft && quotation.terms && (
            <Card title="Terms">
              <p className="whitespace-pre-wrap text-sm">{quotation.terms}</p>
            </Card>
          )}

          {quotation.versions.length > 1 && (
            <Card
              title="Every version"
              description="A revision is a new row. What was sent before is never edited."
            >
              <ul className="flex flex-col gap-1 text-sm">
                {quotation.versions.map((version) => (
                  <li key={version.id} className="flex items-center gap-3">
                    <Link
                      href={`/quotations/${version.id}`}
                      className={version.id === quotation.id ? 'font-medium' : 'underline'}
                    >
                      Version {version.version}
                    </Link>
                    <span className="text-[var(--color-text-muted)]">
                      {QUOTATION_STATUS_LABELS[
                        version.status as keyof typeof QUOTATION_STATUS_LABELS
                      ] ?? version.status}
                    </span>
                    <span className="numeric ml-auto">
                      {formatMoney(version.totalMinor, quotation.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <aside className="flex flex-col gap-4">
          <Card title="This quotation">
            <dl className="flex flex-col">
              <DefinitionRow label="For">
                {partyHref && party ? (
                  <Link href={partyHref} className="underline">
                    {party.fullName}
                  </Link>
                ) : (
                  '—'
                )}
              </DefinitionRow>
              <DefinitionRow label="Deal">
                {quotation.deal ? (
                  <Link href={`/deals/${quotation.deal.id}`} className="underline">
                    {quotation.deal.name}
                  </Link>
                ) : (
                  'None'
                )}
              </DefinitionRow>
              <DefinitionRow label="Raised">{formatDate(quotation.createdAt)}</DefinitionRow>
              {quotation.sentAt && (
                <DefinitionRow label="Sent">
                  {formatDate(quotation.sentAt)}
                  {quotation.sentVia && quotation.sentVia !== 'manual'
                    ? ` by ${quotation.sentVia}`
                    : ''}
                  {quotation.sentTo ? ` to ${quotation.sentTo}` : ''}
                </DefinitionRow>
              )}
              {quotation.acceptedAt && (
                <DefinitionRow label="Accepted">{formatDate(quotation.acceptedAt)}</DefinitionRow>
              )}
              {quotation.rejectedAt && (
                <DefinitionRow label="Turned down">
                  {formatDate(quotation.rejectedAt)}
                  {quotation.rejectedReason ? ` — ${quotation.rejectedReason.name}` : ''}
                </DefinitionRow>
              )}
              {quotation.expiredAt && (
                <DefinitionRow label="Expired">{formatDate(quotation.expiredAt)}</DefinitionRow>
              )}
              {quotation.outcomeNote && (
                <DefinitionRow label="Note">{quotation.outcomeNote}</DefinitionRow>
              )}
            </dl>
          </Card>

          {editable && isDraft && (
            <Card title="Send it">
              <SendQuotationForm quotationId={quotation.id} />
            </Card>
          )}

          {editable && quotation.status === 'sent' && quotation.isCurrent && (
            <Card title="What did they say?">
              <OutcomeForms quotationId={quotation.id} lostReasons={lostReasons} />
            </Card>
          )}

          {editable && !isDraft && quotation.isCurrent && (
            <Card title="Change the price">
              <ReviseButton quotationId={quotation.id} />
            </Card>
          )}

          {editable && isDraft && (
            <Card title="Danger zone">
              <DeleteQuotationButton quotationId={quotation.id} />
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                Only a draft can be deleted. A sent quotation is a document that left the building.
              </p>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}

function FrozenLines({ quotation }: { quotation: QuotationDetail }) {
  if (quotation.items.length === 0) {
    return <p className="text-sm text-[var(--color-text-muted)]">No lines on this quotation.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-left">
            <th className="py-2 pr-4 font-medium">Line</th>
            <th className="py-2 pr-4 font-medium">Qty</th>
            <th className="py-2 pr-4 font-medium">Price</th>
            <th className="py-2 pr-4 font-medium">Discount</th>
            <th className="py-2 pr-4 font-medium">Tax</th>
            <th className="py-2 font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {quotation.items.map((item) => (
            <tr key={item.id} className="border-b border-[var(--color-border)]/60">
              <td className="py-2 pr-4">
                {item.name}
                {item.description && (
                  <span className="block text-xs text-[var(--color-text-muted)]">
                    {item.description}
                  </span>
                )}
              </td>
              <td className="numeric py-2 pr-4">{item.quantity}</td>
              <td className="numeric py-2 pr-4">
                {formatMoney(item.unitPriceMinor, quotation.currency)}
              </td>
              <td className="numeric py-2 pr-4">
                {item.discountMinor === 0
                  ? '—'
                  : formatMoney(item.discountMinor, quotation.currency)}
              </td>
              <td className="numeric py-2 pr-4">{item.taxPercent}%</td>
              <td className="numeric py-2">{formatMoney(item.totalMinor, quotation.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function loadLostReasons(token: string | null): Promise<{ id: string; name: string }[]> {
  try {
    return (await request<{ id: string; name: string }[]>('/crm/lost-reasons', { token })).data;
  } catch {
    return [];
  }
}
