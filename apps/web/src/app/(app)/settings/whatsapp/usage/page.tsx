import Link from 'next/link';
import { describeError } from '@/lib/api';
import { readAccessToken, requireCurrentUser } from '@/lib/session';
import { Card, EmptyState, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import { describeUsageCategory, loadWhatsAppUsage, type WhatsAppUsage } from '@/lib/whatsapp';

/**
 * What WhatsApp cost this workspace (`FR-BIL-4`).
 *
 * Three decisions, and the third is the one worth defending:
 *
 *  * **Counts, by the category Meta billed under.** A `marketing` conversation and a `service` one
 *    cost different amounts, so a single total would be a number nobody could reconcile with an
 *    invoice.
 *  * **Billable *conversations*, not messages.** Meta bills per conversation and marks one message
 *    in each; labelling the figure "messages" would be a wrong answer measured precisely.
 *  * **No money.** Meta's prices are per-country and change, so a rate card in this product would
 *    be wrong within a quarter — and wrong **silently**, on somebody's bill. A screen that says
 *    "about ₹4,200" and is out by a third is worse than one that says what it counted and leaves
 *    the arithmetic to the invoice.
 *
 * Behind `billing:read`, because the person who reconciles an invoice is not necessarily the one
 * who connects a number.
 */
export const metadata = { title: 'WhatsApp usage · Lead OS' };

export default async function WhatsAppUsagePage() {
  await requireCurrentUser();
  const token = await readAccessToken();

  let usage: WhatsAppUsage;
  try {
    usage = await loadWhatsAppUsage(token);
  } catch (error) {
    return (
      <>
        <PageHeader title="WhatsApp usage" />
        {/* Never swallowed into an empty state: a figure is the only reason anybody opened this. */}
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  const month = new Date(usage.from).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  return (
    <>
      <PageHeader
        title="WhatsApp usage"
        description={`${month} so far. Counts only — WhatsApp prices vary by country and change.`}
        action={
          <Link href="/settings/whatsapp" className="text-sm underline">
            Numbers
          </Link>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard
          label="Billable conversations"
          value={String(usage.billableConversations)}
          hint="Meta bills per conversation, not per message."
        />
        <StatCard
          label="Messages sent"
          value={String(usage.messagesSent)}
          hint="Everything that reached WhatsApp, billable or not."
        />
        <StatCard
          label="Categories"
          value={String(usage.byCategory.length)}
          hint="Each is priced differently."
        />
      </div>

      <Card title="By category" description="The category WhatsApp billed each conversation under.">
        {usage.byCategory.length === 0 ? (
          <EmptyState
            title="Nothing billable this month"
            description="A reply inside the 24-hour service window is free, so a month of answering people can cost nothing at all."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {usage.byCategory.map((row) => (
              <li
                key={row.category}
                className="flex items-baseline justify-between rounded-[var(--radius-card)] border border-[var(--color-border)] px-3 py-2 text-sm"
                data-usage-category={row.category}
              >
                <span>{describeUsageCategory(row.category)}</span>
                <span data-usage-count={row.category}>
                  {row.conversations === 1
                    ? '1 conversation'
                    : `${row.conversations} conversations`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-[var(--color-text-muted)]" data-usage-note>
          {usage.note}
        </p>
      </Card>
    </>
  );
}
