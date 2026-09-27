import { describe, expect, it } from 'vitest';
import { ONBOARDING_STEPS, nextStepKey, onboardingProgress } from './onboarding';

describe('onboardingProgress', () => {
  it('marks everything done once the API reports the wizard completed', () => {
    const progress = onboardingProgress({ completed: true, step: 'business_info' });
    expect(progress.every((entry) => entry.status === 'done')).toBe(true);
  });

  it('splits the list into done, current and to-do around the stored step', () => {
    const progress = onboardingProgress({ completed: false, step: ONBOARDING_STEPS[2]!.key });
    expect(progress.map((entry) => entry.status)).toEqual(['done', 'done', 'current', 'todo']);
  });

  it('starts at the beginning when there is no stored state at all', () => {
    expect(onboardingProgress(null)[0]?.status).toBe('current');
  });

  it('treats a step it does not recognise as the beginning rather than throwing', () => {
    // An organization created by another release may record a step this build has never heard of;
    // losing the wizard entirely would be worse than restarting it.
    const progress = onboardingProgress({ completed: false, step: 'a_step_from_the_future' });
    expect(progress[0]?.status).toBe('current');
  });
});

describe('nextStepKey', () => {
  it('walks forward through the list', () => {
    expect(nextStepKey(ONBOARDING_STEPS[0]!.key)).toBe(ONBOARDING_STEPS[1]!.key);
  });

  it('returns null at the end, which is what tells the form to finish instead of advance', () => {
    expect(nextStepKey(ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1]!.key)).toBeNull();
  });
});
