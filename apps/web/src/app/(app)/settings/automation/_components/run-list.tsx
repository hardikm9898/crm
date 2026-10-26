import Link from 'next/link';
import { Badge, EmptyState } from '@/components/ui';
import { relativeWhen } from '@/lib/forms';
import {
  RUN_STATUS_LABELS,
  RUN_STATUS_TONES,
  STEP_STATUS_TONES,
  describeRun,
  describeStep,
  type AutomationCatalogue,
  type RunSummary,
} from '@/lib/automation';

/**
 * What the engine did, per run (`FR-AUT-7`).
 *
 * A server component rather than a client one, and shared by the lead's own screen and the
 * workflow's: "why did this customer get this message?" is asked while looking at a lead, and
 * "what has this workflow been doing?" while looking at a workflow, and they want the same rows.
 *
 * Each run's steps are in a `<details>` so the list stays readable — and the summary line carries
 * the sentence rather than hiding it inside the disclosure, because a collapsed `<details>` has no
 * `innerText` and more importantly because the reason is the thing somebody came for.
 */
export function RunList({
  runs,
  catalogue,
  emptyTitle,
}: {
  runs: readonly RunSummary[];
  catalogue: AutomationCatalogue | null;
  emptyTitle: string;
}) {
  if (runs.length === 0) {
    return (
      <EmptyState
        title={emptyTitle}
        description="A run appears here the moment a workflow starts on this lead."
      />
    );
  }

  return (
    <ul className="flex flex-col gap-3" data-run-list>
      {runs.map((run) => {
        const steps = run.steps;
        return (
          <li
            key={run.id}
            className="rounded-md border border-[var(--color-border)] p-3"
            data-run={run.id}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium" data-run-workflow>
                  <Link href={`/settings/automation/${run.workflow.id}`} className="underline">
                    {run.workflow.name}
                  </Link>
                  <span className="ml-2 text-xs font-normal text-[var(--color-text-muted)]">
                    {`version ${run.version}`}
                    {run.cycle > 1 ? ` · run ${run.cycle} for this lead` : ''}
                  </span>
                </p>
                <p className="text-xs text-[var(--color-text-muted)]" data-run-summary>
                  {describeRun(run)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={RUN_STATUS_TONES[run.status] ?? 'neutral'}>
                  {RUN_STATUS_LABELS[run.status] ?? run.status}
                </Badge>
                <span className="text-xs text-[var(--color-text-muted)]">
                  {relativeWhen(run.startedAt)}
                </span>
              </div>
            </div>

            {steps.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-[var(--color-primary)]">
                  {`${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`}
                </summary>
                <ol className="mt-2 flex flex-col gap-1.5">
                  {steps.map((step) => (
                    <li
                      key={step.id}
                      className="flex flex-wrap items-start gap-2 text-xs"
                      data-run-step={step.stepId}
                    >
                      <Badge tone={STEP_STATUS_TONES[step.status] ?? 'neutral'}>
                        {step.status}
                      </Badge>
                      <span className="min-w-0 break-words" data-run-step-text>
                        {describeStep(step, catalogue)}
                      </span>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}
