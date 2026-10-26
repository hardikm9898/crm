import Link from 'next/link';
import { describeError } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Badge, Card, DataTable, EmptyState, ErrorNotice, PageHeader } from '@/components/ui';
import { relativeWhen } from '@/lib/forms';
import {
  REENTRY_LABELS,
  STATUS_LABELS,
  STATUS_TONES,
  describeWorkflow,
  loadCatalogue,
  loadWorkflows,
  type AutomationCatalogue,
  type WorkflowSummary,
} from '@/lib/automation';
import { NewWorkflowForm, WorkflowRowActions } from './_components/workflow-forms';

/**
 * The workflows this workspace has (`FR-AUT-4`).
 *
 * Behind `automation:manage`, and read through the loaders that **throw**: on a screen whose whole
 * job is to list workflows, a swallowed failure would say "none yet" to a workspace whose
 * automation is live, and the obvious next action from that screen is to build a second one. That
 * is the `loadProducts` lesson, and it is why neither loader here has a catch that renders an
 * empty state.
 *
 * Nothing runs yet — the executor is the next step — so the screen says so once, at the top,
 * rather than letting somebody publish and wonder. A product that explains its own half-built
 * state is better than one that looks finished and does nothing.
 */
export const dynamic = 'force-dynamic';

export default async function AutomationPage() {
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  if (!can(user, 'automation:manage')) {
    return (
      <>
        <PageHeader title="Automation" />
        <ErrorNotice>Your role does not include this workspace’s automation.</ErrorNotice>
      </>
    );
  }

  let catalogue: AutomationCatalogue;
  let workflows: { items: WorkflowSummary[]; total: number };
  try {
    [catalogue, workflows] = await Promise.all([loadCatalogue(token), loadWorkflows(token)]);
  } catch (error) {
    return (
      <>
        <PageHeader title="Automation" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Automation"
        description="A thing that happens, and what should follow from it — written once and then left alone."
        action={
          <Link href="/settings" className="text-sm underline">
            Back to settings
          </Link>
        }
      />

      <div className="flex flex-col gap-5">
        {/* This card said "Nothing runs yet" for a release after the engine shipped — a screen
            telling a business owner their published workflow is not working while it was. A
            sentence about what the product cannot do yet has to be deleted by the step that makes
            it untrue, and it was not. */}
        <Card
          title="A published workflow is a running workflow"
          description="Publishing makes it live: the trigger below starts it, each step runs in order, and every decision — including the ones that skipped — is on the lead’s own timeline. Try one against a real lead first; a test sends nothing."
        >
          <p className="text-sm text-[var(--color-text-muted)]" data-executor-notice>
            {`${catalogue.triggers.length} things can start a workflow, and ${catalogue.actions.length} things can happen in one.`}
          </p>
        </Card>

        <Card title="Add a workflow">
          <NewWorkflowForm />
        </Card>

        <Card title="Your workflows" description={`${workflows.total} in this workspace.`}>
          {workflows.items.length === 0 ? (
            <EmptyState
              title="No workflows yet"
              description="The first one most businesses write greets a new lead and books a follow-up."
            />
          ) : (
            <DataTable columns={['Workflow', 'State', 'Re-entry', 'Changed', '']}>
              {workflows.items.map((workflow) => (
                <tr key={workflow.id} data-workflow-row={workflow.id}>
                  <td className="py-3 pr-4">
                    <Link
                      href={`/settings/automation/${workflow.id}`}
                      className="font-medium underline"
                      data-workflow-name
                    >
                      {workflow.name}
                    </Link>
                    <p className="text-xs text-[var(--color-text-muted)]" data-workflow-summary>
                      {describeWorkflow(workflow, catalogue)}
                    </p>
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge tone={STATUS_TONES[workflow.status] ?? 'neutral'}>
                        {STATUS_LABELS[workflow.status] ?? workflow.status}
                      </Badge>
                      {workflow.killSwitch && <Badge tone="danger">Stopped</Badge>}
                    </div>
                  </td>
                  <td className="py-3 pr-4 text-sm text-[var(--color-text-muted)]">
                    {REENTRY_LABELS[workflow.reentryPolicy] ?? workflow.reentryPolicy}
                    {workflow.reentryPolicy === 'cooldown' && workflow.cooldownHours !== null
                      ? ` · ${workflow.cooldownHours}h`
                      : ''}
                  </td>
                  <td className="py-3 pr-4 text-sm text-[var(--color-text-muted)]">
                    {relativeWhen(workflow.updatedAt)}
                  </td>
                  <td className="py-3">
                    <WorkflowRowActions workflow={workflow} />
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </Card>
      </div>
    </>
  );
}
