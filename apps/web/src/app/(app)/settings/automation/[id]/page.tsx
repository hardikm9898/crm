import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, describeError } from '@/lib/api';
import { can, readAccessToken, requireCurrentUser } from '@/lib/session';
import { Badge, Card, DataTable, ErrorNotice, PageHeader } from '@/components/ui';
import { relativeWhen } from '@/lib/forms';
import {
  REENTRY_LABELS,
  STATUS_LABELS,
  STATUS_TONES,
  loadCatalogue,
  loadReferenceLists,
  loadWorkflow,
  type AutomationCatalogue,
  type ReferenceLists,
  type WorkflowRecord,
} from '@/lib/automation';
import { WorkflowEditor } from '../_components/workflow-editor';
import { GuardrailsForm, PublishButton } from '../_components/workflow-forms';

/**
 * One workflow: what starts it, what it does, and what has been published (`FR-AUT-5`).
 *
 * The editor is handed the catalogue and the reference lists and renders itself from them; this
 * page's own job is the three things around it — the publish button with the API's own refusal
 * underneath it, the guardrails, and the version history that makes "editing a live workflow does
 * not alter in-flight runs" visible rather than merely true.
 */
export const dynamic = 'force-dynamic';

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireCurrentUser();
  const token = await readAccessToken();

  if (!can(user, 'automation:manage')) {
    return (
      <>
        <PageHeader title="Workflow" />
        <ErrorNotice>Your role does not include this workspace’s automation.</ErrorNotice>
      </>
    );
  }

  let workflow: WorkflowRecord;
  let catalogue: AutomationCatalogue;
  try {
    [workflow, catalogue] = await Promise.all([loadWorkflow(token, id), loadCatalogue(token)]);
  } catch (error) {
    // A workflow that is not this workspace's answers 404, which is the same answer a made-up id
    // gets: the shape of an id must not become an oracle.
    if (error instanceof ApiError && error.status === 404) notFound();
    return (
      <>
        <PageHeader title="Workflow" />
        <ErrorNotice>{describeError(error)}</ErrorNotice>
      </>
    );
  }

  const references: ReferenceLists = await loadReferenceLists(token, catalogue);
  const editable = workflow.draft ?? workflow.current;

  return (
    <>
      <PageHeader
        title={workflow.name}
        description={workflow.description ?? undefined}
        action={
          <Link href="/settings/automation" className="text-sm underline">
            All workflows
          </Link>
        }
      />

      <div className="flex flex-col gap-5">
        <Card title="State">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Badge tone={STATUS_TONES[workflow.status] ?? 'neutral'}>
                {STATUS_LABELS[workflow.status] ?? workflow.status}
              </Badge>
              {workflow.killSwitch && <Badge tone="danger">Stopped</Badge>}
            </div>
            <p className="text-sm text-[var(--color-text-muted)]" data-live-version>
              {workflow.current === null
                ? 'Nothing published yet.'
                : `Version ${workflow.current.version} is the published one${
                    workflow.draft ? `, and version ${workflow.draft.version} is a draft.` : '.'
                  }`}
            </p>
            <PublishButton
              workflowId={workflow.id}
              blockedReason={workflow.publishBlockedReason}
              hasDraft={workflow.draft !== null}
            />
          </div>
        </Card>

        {workflow.problems.length > 0 && (
          <Card
            title="Still to fill in"
            description="Each one names the step it belongs to, and the editor shows it there too."
          >
            <ul className="flex flex-col gap-1 text-sm" data-problem-list>
              {workflow.problems.map((problem) => (
                <li key={`${problem.field}-${problem.code}`} className="text-[var(--color-danger)]">
                  {problem.message}
                </li>
              ))}
            </ul>
          </Card>
        )}

        <WorkflowEditor
          workflowId={workflow.id}
          catalogue={catalogue}
          references={references}
          initial={editable?.definition ?? { trigger: { type: '' }, steps: [] }}
          problems={workflow.problems}
          readOnly={workflow.status === 'archived'}
        />

        <Card title="Limits" description="What stops this running more than it should.">
          <div className="flex flex-col gap-2">
            <GuardrailsForm workflow={workflow} />
            <p className="text-xs text-[var(--color-text-muted)]">
              {`Currently: ${REENTRY_LABELS[workflow.reentryPolicy] ?? workflow.reentryPolicy}${
                workflow.maxRunsPerEntity === null
                  ? ''
                  : `, at most ${workflow.maxRunsPerEntity} per lead`
              }.`}
            </p>
          </div>
        </Card>

        <Card
          title="Versions"
          description="A published version is never written again, so anything already running keeps the version it started on."
        >
          <DataTable columns={['Version', 'State', 'When']}>
            {workflow.versions.map((version) => (
              <tr key={version.id} data-version={version.version}>
                <td className="py-2 pr-4 font-medium">{version.version}</td>
                <td className="py-2 pr-4">
                  {version.isDraft ? (
                    <Badge>Draft</Badge>
                  ) : version.id === workflow.currentVersionId ? (
                    <Badge tone="success">Published</Badge>
                  ) : (
                    <Badge>Superseded</Badge>
                  )}
                </td>
                <td className="py-2 text-sm text-[var(--color-text-muted)]">
                  {relativeWhen(version.publishedAt ?? version.createdAt)}
                </td>
              </tr>
            ))}
          </DataTable>
        </Card>
      </div>
    </>
  );
}
