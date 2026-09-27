/**
 * The onboarding wizard's step list.
 *
 * The API stores `{ completed, step, data }` and deliberately does not define what the steps are —
 * "the wizard owns the shape, not the API". Keeping the list here means adding a step is a frontend
 * change, and an organization created by an older release simply resumes at whichever step it
 * recorded.
 */
export interface OnboardingState {
  completed?: boolean;
  step?: string;
  completedAt?: string;
  data?: Record<string, unknown>;
}

export interface OnboardingStep {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** Set when the step's screen arrives in a later phase. */
  readonly phase?: number;
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    key: 'business_info',
    label: 'Describe the business',
    description: 'Name, industry, timezone and currency — these shape every screen and report.',
  },
  {
    key: 'structure',
    label: 'Set up branches and teams',
    description: 'How the business is organised decides who can see which records.',
  },
  {
    key: 'people',
    label: 'Invite your team',
    description: 'Each person gets a role, and each role decides what they may do.',
  },
  {
    key: 'pipeline',
    label: 'Design your pipeline',
    description: 'Statuses, sources and stages, in your own words.',
    phase: 2,
  },
];

export type StepStatus = 'done' | 'current' | 'todo';

export function onboardingProgress(
  state: OnboardingState | null,
): { step: OnboardingStep; status: StepStatus }[] {
  if (state?.completed === true) {
    return ONBOARDING_STEPS.map((step) => ({ step, status: 'done' as StepStatus }));
  }

  const currentIndex = ONBOARDING_STEPS.findIndex((step) => step.key === state?.step);
  // An unrecognised stored step (an older or newer release) is treated as "at the beginning"
  // rather than throwing the wizard away.
  const resolved = currentIndex === -1 ? 0 : currentIndex;

  return ONBOARDING_STEPS.map((step, index) => ({
    step,
    status: index < resolved ? 'done' : index === resolved ? 'current' : 'todo',
  }));
}

export function nextStepKey(current: string | undefined): string | null {
  const index = ONBOARDING_STEPS.findIndex((step) => step.key === current);
  const next = ONBOARDING_STEPS[index + 1];
  return next?.key ?? null;
}
