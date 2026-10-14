import { describeError } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Card, ErrorNotice, PageHeader } from '@/components/ui';
import { loadCallOutcomes } from '@/lib/calls';
import { CallOutcomeRow, NewCallOutcomeForm } from '../../calls/_components/call-forms';

/**
 * What a call meant, as the workspace's own list (`FR-CALL-3`, rule 4).
 *
 * Here rather than on the call screen for the reason the follow-up vocabulary is: renaming an
 * outcome changes what every past call reads as, which is not a thing to do from the screen where
 * somebody is logging one.
 *
 * Reads through the **throwing** loader. On a screen whose whole job is to list the outcomes, an
 * empty list and a failed request look identical and must not — the mistake the product catalogue
 * shipped with, where a swallowed 400 told every workspace it had no products.
 */
export const dynamic = 'force-dynamic';

export default async function CallOutcomeSettingsPage() {
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  if (!can(user, 'settings:manage')) {
    return (
      <>
        <PageHeader title="Call outcomes" />
        <ErrorNotice>You do not have permission to change this workspace’s settings.</ErrorNotice>
      </>
    );
  }

  let outcomes: Awaited<ReturnType<typeof loadCallOutcomes>>;
  try {
    outcomes = await loadCallOutcomes(token, '?includeInactive=true');
  } catch (error) {
    return (
      <>
        <PageHeader title="Call outcomes" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Call outcomes"
        description="What a call can end as — in this business’s own words."
      />

      <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
        <Card
          title="The list"
          description="Deactivate an outcome to stop offering it without rewriting what past calls ended as. The kind beside each name is what the product understands."
        >
          {outcomes.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              No outcomes yet. Logging a call needs one, so add the first on the right.
            </p>
          ) : (
            <div className="flex flex-col">
              {outcomes.map((outcome) => (
                <CallOutcomeRow key={outcome.id} outcome={outcome} />
              ))}
            </div>
          )}
        </Card>

        <Card title="Add an outcome">
          <NewCallOutcomeForm />
        </Card>
      </div>
    </>
  );
}
