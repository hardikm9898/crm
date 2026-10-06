'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Badge, Button, ErrorNotice } from '@/components/ui';
import { IDLE } from '@/lib/action-state';
import { NEXT_ACTIONS, onboardingProgress, type OnboardingState } from '@/lib/onboarding';
import { advanceOnboarding } from './actions';

/**
 * The setup checklist.
 *
 * Progress is stored server-side, so it survives a new device and is visible to whoever else
 * administers the workspace — a wizard kept in `localStorage` restarts for the second administrator
 * and looks broken.
 */
export function OnboardingWizard({ state }: { state: OnboardingState | null }) {
  const [result, submit, pending] = useActionState(advanceOnboarding, IDLE);
  const progress = onboardingProgress(state);
  const current = progress.find((entry) => entry.status === 'current');
  const complete = current === undefined;

  return (
    <div className="flex flex-col gap-4">
      {result.status === 'error' && <ErrorNotice>{result.message}</ErrorNotice>}
      {result.status === 'success' && (
        <p role="status" className="text-sm text-[var(--color-success)]">
          {result.message}
        </p>
      )}

      <ol className="flex flex-col gap-3">
        {progress.map(({ step, status }) => (
          <li key={step.key} className="flex items-start justify-between gap-4">
            <div>
              <p
                className={`text-sm font-medium ${status === 'done' ? 'text-[var(--color-text-muted)]' : ''}`}
              >
                {step.label}
              </p>
              <p className="text-sm text-[var(--color-text-muted)]">{step.description}</p>
            </div>
            {status === 'done' ? (
              <Badge tone="success">Done</Badge>
            ) : status === 'current' ? (
              <Badge tone="warning">Now</Badge>
            ) : (
              <Badge>Later</Badge>
            )}
          </li>
        ))}
      </ol>

      {complete ? (
        /*
         * "Your CRM is ready", with three things to click (`FR-ONB-3`).
         *
         * A congratulations screen with nothing on it is where a trial goes to die, so each of
         * these is a link to a screen that exists and the thing somebody in that position actually
         * does next. The checklist above stays visible rather than disappearing, because the
         * adoption nudge is "you have not imported anything yet", not a tick.
         */
        <div className="flex flex-col gap-3" data-onboarding-complete>
          <p className="text-sm font-medium text-[var(--color-success)]">
            Your CRM is ready. Here is what to do next.
          </p>
          <ul className="flex flex-col gap-2">
            {NEXT_ACTIONS.map((action) => (
              <li key={action.href}>
                <Link href={action.href} className="text-sm font-medium underline">
                  {action.label}
                </Link>
                <p className="text-sm text-[var(--color-text-muted)]">{action.description}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <form action={submit} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="step" value={current.step.key} />
          {/* The last step finishes the wizard, which the API records with a timestamp and an event. */}
          <input
            type="hidden"
            name="finish"
            value={String(progress[progress.length - 1]?.step.key === current.step.key)}
          />
          <Button type="submit" pending={pending}>
            {pending
              ? 'Saving…'
              : progress[progress.length - 1]?.step.key === current.step.key
                ? 'Finish setup'
                : `Mark “${current.step.label}” done`}
          </Button>
          <span className="text-xs text-[var(--color-text-muted)]">
            {current.step.phase === undefined
              ? 'You can come back to this at any time.'
              : `The screen for this step arrives in phase ${current.step.phase}; marking it done records your intent.`}
          </span>
        </form>
      )}
    </div>
  );
}
