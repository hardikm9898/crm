import { describeError } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Card, ErrorNotice, PageHeader } from '@/components/ui';
import { loadSlaPoliciesOrThrow } from '@/lib/sla';
import { NewSlaPolicyForm, SlaPolicyRow } from '../../sla/_components/sla-forms';

/**
 * The promises a workspace makes (`FR-TSK-8`, rule 4).
 *
 * Reads through the **throwing** loader: on a screen whose whole job is to list the policies, an
 * empty list and a failed request look identical and must not — the mistake the product catalogue
 * shipped with.
 *
 * Two sentences on this screen exist because the alternative is a support conversation: editing a
 * target does not move the clocks already running, and a policy that clocks have run against can be
 * deactivated but not deleted.
 */
export const dynamic = 'force-dynamic';

export default async function SlaSettingsPage() {
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  if (!can(user, 'settings:manage')) {
    return (
      <>
        <PageHeader title="Response time promises" />
        <ErrorNotice>You do not have permission to change this workspace’s settings.</ErrorNotice>
      </>
    );
  }

  let policies: Awaited<ReturnType<typeof loadSlaPoliciesOrThrow>>;
  try {
    policies = await loadSlaPoliciesOrThrow(token, '?includeInactive=true');
  } catch (error) {
    return (
      <>
        <PageHeader title="Response time promises" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Response time promises"
        description="How fast this business answers a new enquiry, and who hears about it when it does not."
      />

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <Card
          title="The policies"
          description="Consulted in order; the first one that matches a lead governs it, and a narrower policy wins over a broader one at the same order. Editing a target does not move the clocks already running — a promise that was made was made."
        >
          {policies.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              No policies yet, so no lead has a promise attached to it. Add the first one on the
              right.
            </p>
          ) : (
            <div className="flex flex-col">
              {policies.map((policy) => (
                <SlaPolicyRow key={policy.id} policy={policy} />
              ))}
            </div>
          )}
          <p className="mt-4 text-xs text-[var(--color-text-muted)]">
            A policy that clocks have already run against can be deactivated but not deleted: a
            breach report has to be able to say what the promise was. Working hours come from the
            workspace’s own calendar, so a lead arriving at 18:50 on a Friday is not late at 19:50.
          </p>
        </Card>

        <Card title="Add a policy">
          <NewSlaPolicyForm />
        </Card>
      </div>
    </>
  );
}
