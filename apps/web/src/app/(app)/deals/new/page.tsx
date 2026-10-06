import Link from 'next/link';
import { redirect } from 'next/navigation';
import { request } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { NewDealForm } from '../_components/deal-forms';

/**
 * A new deal.
 *
 * Reached with `?leadId=` or `?customerId=` from the record it is for — which is where somebody
 * actually starts, because a deal with nobody attached is a forecast of money from nowhere, and the
 * API refuses it. Arriving here with neither shows the two places to start rather than a form that
 * cannot be submitted.
 */
export const dynamic = 'force-dynamic';

export default async function NewDealPage({
  searchParams,
}: {
  searchParams: Promise<{ leadId?: string; customerId?: string }>;
}) {
  const { leadId, customerId } = await searchParams;
  const user = await requireCurrentUser();
  if (!can(user, 'deal:manage')) redirect('/deals');
  const token = await readAccessToken();

  if (!leadId && !customerId) {
    return (
      <>
        <PageHeader title="New deal" />
        <Card>
          <EmptyState
            title="Who is the deal with?"
            description="A deal belongs to a lead or a customer — that is what makes it a forecast rather than a number. Open the record and start from there."
            action={
              <span className="flex gap-3 text-sm">
                <Link href="/leads" className="underline">
                  Leads
                </Link>
                <Link href="/customers" className="underline">
                  Customers
                </Link>
              </span>
            }
          />
        </Card>
      </>
    );
  }

  const stages = await loadDealStages(token);

  return (
    <>
      <PageHeader
        title="New deal"
        description="Its value can be a figure now and line items later — the items replace the figure."
        action={
          <Link
            href={customerId ? `/customers/${customerId}` : `/leads/${leadId}`}
            className="text-sm underline"
          >
            Back
          </Link>
        }
      />
      <Card>
        <NewDealForm
          {...(leadId ? { leadId } : {})}
          {...(customerId ? { customerId } : {})}
          stages={stages}
        />
      </Card>
    </>
  );
}

async function loadDealStages(token: string | null): Promise<{ id: string; name: string }[]> {
  try {
    const response = await request<
      {
        id: string;
        isDefault: boolean;
        stages: { id: string; name: string; isWon: boolean; isLost: boolean }[];
      }[]
    >('/crm/pipelines?entityType=deal', { token });
    const pipeline = response.data.find((candidate) => candidate.isDefault) ?? response.data[0];
    // Won and lost are outcomes, not places to start a deal.
    return (pipeline?.stages ?? [])
      .filter((stage) => !stage.isWon && !stage.isLost)
      .map((stage) => ({ id: stage.id, name: stage.name }));
  } catch {
    return [];
  }
}
