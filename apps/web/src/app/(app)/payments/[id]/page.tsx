import Link from 'next/link';
import { describeError } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Card, DefinitionRow, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import { formatDate, formatDateTime, formatMoney } from '@/lib/lead-format';
import {
  PAYMENT_STATUS_CLASSES,
  PAYMENT_STATUS_LABELS,
  loadPayment,
  loadPaymentMethods,
  type PaymentSummary,
} from '@/lib/payments';
import {
  CorrectPaymentForm,
  DeletePaymentButton,
  PaymentOutcomeForms,
} from '../_components/payment-forms';

/** One receipt: what arrived, from whom, by what method, and what became of it. */
export const dynamic = 'force-dynamic';

export default async function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  let payment: PaymentSummary;
  try {
    payment = await loadPayment(id, token);
  } catch (error) {
    return (
      <>
        <PageHeader title="Payment" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  const methods = await loadPaymentMethods(token, '?includeInactive=true');
  const editable = can(user, 'payment:record') && payment.deletedAt === null;
  const party = payment.customer ?? payment.lead;
  const partyHref = payment.customer
    ? `/customers/${payment.customer.id}`
    : payment.lead
      ? `/leads/${payment.lead.id}`
      : null;

  return (
    <>
      <PageHeader
        title={payment.number}
        description={payment.method ? `By ${payment.method.name}` : undefined}
        action={
          <div className="flex items-center gap-3">
            <span
              className={`inline-block rounded px-2 py-0.5 text-xs ${PAYMENT_STATUS_CLASSES[payment.status]}`}
            >
              {PAYMENT_STATUS_LABELS[payment.status]}
            </span>
            <Link href="/payments" className="text-sm underline">
              All payments
            </Link>
          </div>
        }
      />

      {payment.deletedAt && (
        <div className="mb-4">
          <ErrorNotice>
            This payment was deleted on {formatDateTime(payment.deletedAt)}. It is out of every
            total.
          </ErrorNotice>
        </div>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard label="Amount" value={formatMoney(payment.amountMinor, payment.currency)} />
        <StatCard
          label="Received"
          value={payment.paidAt ? formatDate(payment.paidAt) : 'Not yet'}
        />
        <StatCard label="Method" value={payment.method?.name ?? '—'} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-4">
          <Card title="This receipt">
            <dl className="flex flex-col">
              <DefinitionRow label="From">
                {partyHref && party ? (
                  <Link href={partyHref} className="underline">
                    {party.fullName}
                  </Link>
                ) : (
                  '—'
                )}
              </DefinitionRow>
              <DefinitionRow label="Against">
                {payment.deal ? (
                  <Link href={`/deals/${payment.deal.id}`} className="underline">
                    {payment.deal.name}
                  </Link>
                ) : (
                  'No deal'
                )}
              </DefinitionRow>
              {payment.quotation && (
                <DefinitionRow label="Quotation">
                  <Link href={`/quotations/${payment.quotation.id}`} className="underline">
                    {payment.quotation.label}
                  </Link>
                </DefinitionRow>
              )}
              <DefinitionRow label="Reference">{payment.reference ?? '—'}</DefinitionRow>
              <DefinitionRow label="Recorded">{formatDateTime(payment.createdAt)}</DefinitionRow>
              {payment.failedAt && (
                <DefinitionRow label="Failed">{formatDate(payment.failedAt)}</DefinitionRow>
              )}
              {payment.refundedAt && (
                <DefinitionRow label="Refunded">{formatDate(payment.refundedAt)}</DefinitionRow>
              )}
              {payment.outcomeNote && (
                <DefinitionRow label="Note">{payment.outcomeNote}</DefinitionRow>
              )}
            </dl>
          </Card>

          {editable && payment.status !== 'refunded' && (
            <Card
              title="Correct it"
              description="For a figure somebody typed wrong. The receipt keeps its number."
            >
              <CorrectPaymentForm payment={payment} methods={methods} />
            </Card>
          )}
        </div>

        <aside className="flex flex-col gap-4">
          {editable && (
            <Card title="What happened to it?">
              <PaymentOutcomeForms payment={payment} />
            </Card>
          )}
          {editable && (
            <Card title="Danger zone">
              <DeletePaymentButton paymentId={payment.id} />
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                For a payment entered against the wrong record. It leaves every total; the row stays
                so somebody can see what happened.
              </p>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}
