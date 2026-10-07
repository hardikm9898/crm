import { describeError } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Card, ErrorNotice, PageHeader } from '@/components/ui';
import { loadRescheduleReasons, loadTaskOutcomes, loadTaskTypes } from '@/lib/tasks';
import {
  NewRescheduleReasonForm,
  NewTaskOutcomeForm,
  NewTaskTypeForm,
  RescheduleReasonRow,
  TaskOutcomeRow,
  TaskTypeRow,
} from '../../tasks/_components/config-forms';

/**
 * The follow-up vocabulary: kinds, outcomes and reasons for moving one (rule 4).
 *
 * Reads through the **throwing** loaders: on a screen whose whole job is to list these, an empty
 * list and a failed request look identical and must not — the mistake the product catalogue shipped
 * with, where a swallowed 400 told every workspace it had no products.
 *
 * Two of these lists cannot be emptied, and the screen says so rather than letting somebody find
 * out from a constraint name: finishing a follow-up requires an outcome and moving one requires a
 * reason, both enforced by the API.
 */
export const dynamic = 'force-dynamic';

export default async function FollowUpSettingsPage() {
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  if (!can(user, 'settings:manage')) {
    return (
      <>
        <PageHeader title="Follow-ups" />
        <ErrorNotice>You do not have permission to change this workspace’s settings.</ErrorNotice>
      </>
    );
  }

  let types: Awaited<ReturnType<typeof loadTaskTypes>>;
  let outcomes: Awaited<ReturnType<typeof loadTaskOutcomes>>;
  let reasons: Awaited<ReturnType<typeof loadRescheduleReasons>>;
  try {
    [types, outcomes, reasons] = await Promise.all([
      loadTaskTypes(token, '?includeInactive=true'),
      loadTaskOutcomes(token, '?includeInactive=true'),
      loadRescheduleReasons(token, '?includeInactive=true'),
    ]);
  } catch (error) {
    return (
      <>
        <PageHeader title="Follow-ups" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Follow-ups"
        description="What kinds of follow-up this business does, how they turn out, and why they move."
      />

      <div className="flex flex-col gap-5">
        <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
          <Card
            title="Kinds of follow-up"
            description="Each one carries how long it usually takes and when to be reminded, so the form is one field long."
          >
            {types.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                No kinds yet. Add the first one on the right.
              </p>
            ) : (
              <div className="flex flex-col">
                {types.map((type) => (
                  <TaskTypeRow key={type.id} type={type} />
                ))}
              </div>
            )}
          </Card>
          <Card title="Add a kind">
            <NewTaskTypeForm />
          </Card>
        </div>

        <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
          <Card
            title="Outcomes"
            description="Finishing a follow-up asks for one of these, which is what makes “forty calls, nine of them positive” a sentence anybody can say. The last one cannot be removed."
          >
            {outcomes.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                No outcomes yet. Add the first one on the right.
              </p>
            ) : (
              <div className="flex flex-col">
                {outcomes.map((outcome) => (
                  <TaskOutcomeRow key={outcome.id} outcome={outcome} />
                ))}
              </div>
            )}
          </Card>
          <Card title="Add an outcome">
            <NewTaskOutcomeForm />
          </Card>
        </div>

        <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
          <Card
            title="Reasons for moving one"
            description="Moving a follow-up asks for one of these every time. The count beside each is the coaching report: “pushed five times, four because the decision maker was away”."
          >
            {reasons.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                No reasons yet. Add the first one on the right.
              </p>
            ) : (
              <div className="flex flex-col">
                {reasons.map((reason) => (
                  <RescheduleReasonRow key={reason.id} reason={reason} />
                ))}
              </div>
            )}
          </Card>
          <Card title="Add a reason">
            <NewRescheduleReasonForm />
          </Card>
        </div>
      </div>
    </>
  );
}
