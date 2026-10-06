import Link from 'next/link';
import { describeError, request } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Badge, Card, DefinitionRow, ErrorNotice, PageHeader, StatCard } from '@/components/ui';
import { Timeline } from '@/components/timeline';
import { formatDate, formatDateTime, formatMoney } from '@/lib/lead-format';
import { loadDeal, loadDealTimeline, loadProducts, type DealDetail } from '@/lib/deals';
import type { TimelineEntryLike } from '@/lib/timeline-registry';
import {
  DeleteDealButton,
  LineItemsEditor,
  OutcomeControls,
  StageControl,
} from '../_components/deal-forms';

/**
 * A deal: what is being sold, to whom, for how much, and what happened.
 *
 * The line-items editor is the centre of the screen because it is the thing a quotation is. Its
 * totals come from the API, not from the browser — the arithmetic lives in one place
 * (`@leados/shared`), the database enforces it, and a figure computed twice is a figure that will
 * eventually disagree with itself in front of a customer.
 */
export const dynamic = 'force-dynamic';

export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  let deal: DealDetail;
  try {
    deal = await loadDeal(id, token);
  } catch (error) {
    return (
      <>
        <PageHeader title="Deal" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  const [timeline, products, stages, lostReasons] = await Promise.all([
    loadDealTimeline(id, token).catch(() => [] as TimelineEntryLike[]),
    loadProducts(token),
    loadStages(deal.pipeline.id, token),
    loadLostReasons(token),
  ]);

  const editable = can(user, 'deal:manage') && deal.deletedAt === null;
  const party = deal.customer ?? deal.lead;
  const partyHref = deal.customer
    ? `/customers/${deal.customer.id}`
    : deal.lead
      ? `/leads/${deal.lead.id}`
      : null;

  return (
    <>
      <PageHeader
        title={deal.name}
        description={
          party ? `${deal.customer ? 'Customer' : 'Lead'}: ${party.fullName}` : undefined
        }
        action={
          <div className="flex items-center gap-3">
            {deal.outcome === 'won' ? (
              <Badge tone="success">Won {deal.wonAt ? formatDate(deal.wonAt) : ''}</Badge>
            ) : deal.outcome === 'lost' ? (
              <Badge tone="danger">Lost {deal.lostAt ? formatDate(deal.lostAt) : ''}</Badge>
            ) : (
              <Badge>{deal.stage.name ?? 'Open'}</Badge>
            )}
            <Link href="/deals" className="text-sm underline">
              All deals
            </Link>
          </div>
        }
      />

      {deal.deletedAt && (
        <div className="mb-4">
          <ErrorNotice>This deal was deleted on {formatDateTime(deal.deletedAt)}.</ErrorNotice>
        </div>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatCard label="Value" value={formatMoney(deal.valueMinor, deal.currency)} />
        <StatCard
          label="Weighted"
          value={formatMoney(deal.weightedMinor, deal.currency)}
          hint={`${deal.probability}% at this stage`}
        />
        <StatCard label="Tax" value={formatMoney(deal.taxMinor, deal.currency)} />
        <StatCard
          label="Closing"
          value={deal.expectedCloseDate ? formatDate(deal.expectedCloseDate) : '—'}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-4">
          <Card
            title="What is being sold"
            description="Each line records what was agreed. Tax is per line, because one quotation often mixes rates."
          >
            {editable ? (
              <LineItemsEditor
                dealId={deal.id}
                items={deal.items}
                products={products}
                currency={deal.currency}
                disabled={deal.outcome !== 'open'}
              />
            ) : (
              <ReadOnlyItems deal={deal} />
            )}
          </Card>

          <Card title="History" description="Every move on this deal, newest first.">
            {timeline.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">Nothing recorded yet.</p>
            ) : (
              <Timeline entries={timeline} now={new Date().toISOString()} />
            )}
          </Card>
        </div>

        <aside className="flex flex-col gap-4">
          <Card title="This deal">
            <dl className="flex flex-col">
              <DefinitionRow label="With">
                {partyHref && party ? (
                  <Link href={partyHref} className="underline">
                    {party.fullName}
                  </Link>
                ) : (
                  '—'
                )}
              </DefinitionRow>
              <DefinitionRow label="Owner">{deal.owner?.name ?? 'Nobody'}</DefinitionRow>
              <DefinitionRow label="Pipeline">{deal.pipeline.name}</DefinitionRow>
              <DefinitionRow label="Opened">{formatDate(deal.createdAt)}</DefinitionRow>
              {deal.lostReason && (
                <DefinitionRow label="Lost because">{deal.lostReason.name}</DefinitionRow>
              )}
              {deal.lostNote && <DefinitionRow label="Note">{deal.lostNote}</DefinitionRow>}
            </dl>
          </Card>

          {editable && (
            <>
              <Card title="Outcome">
                <OutcomeControls
                  dealId={deal.id}
                  outcome={deal.outcome}
                  lostReasons={lostReasons}
                />
              </Card>
              {deal.outcome === 'open' && stages.length > 0 && (
                <Card title="Move this deal">
                  <StageControl dealId={deal.id} stages={stages} currentStageId={deal.stage.id} />
                </Card>
              )}
              <Card title="Danger zone">
                <DeleteDealButton dealId={deal.id} />
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  Reversible. The deal keeps its history.
                </p>
              </Card>
            </>
          )}
        </aside>
      </div>
    </>
  );
}

function ReadOnlyItems({ deal }: { deal: DealDetail }) {
  if (deal.items.length === 0) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">
        No line items — the value was entered directly.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)] text-left">
            <th className="py-2 pr-4 font-medium">Line</th>
            <th className="py-2 pr-4 font-medium">Qty</th>
            <th className="py-2 pr-4 font-medium">Price</th>
            <th className="py-2 pr-4 font-medium">Tax</th>
            <th className="py-2 font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {deal.items.map((item) => (
            <tr key={item.id} className="border-b border-[var(--color-border)]/60">
              <td className="py-2 pr-4">{item.name}</td>
              <td className="numeric py-2 pr-4">{item.quantity}</td>
              <td className="numeric py-2 pr-4">
                {formatMoney(item.unitPriceMinor, deal.currency)}
              </td>
              <td className="numeric py-2 pr-4">{item.taxPercent}%</td>
              <td className="numeric py-2">{formatMoney(item.totalMinor, deal.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function loadStages(
  pipelineId: string,
  token: string | null,
): Promise<{ id: string; name: string; probability: number }[]> {
  try {
    const response = await request<
      { id: string; stages: { id: string; name: string; probability: number | null }[] }[]
    >('/crm/pipelines?entityType=deal', { token });
    const pipeline = response.data.find((candidate) => candidate.id === pipelineId);
    return (pipeline?.stages ?? []).map((stage) => ({
      id: stage.id,
      name: stage.name,
      probability: stage.probability ?? 0,
    }));
  } catch {
    return [];
  }
}

async function loadLostReasons(token: string | null): Promise<{ id: string; name: string }[]> {
  try {
    return (await request<{ id: string; name: string }[]>('/crm/lost-reasons', { token })).data;
  } catch {
    return [];
  }
}
