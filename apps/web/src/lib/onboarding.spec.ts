import { describe, expect, it } from 'vitest';
import { NEXT_ACTIONS, ONBOARDING_STEPS, nextStepKey, onboardingProgress } from './onboarding';

describe('onboardingProgress', () => {
  it('marks everything done once the API reports the wizard completed', () => {
    const progress = onboardingProgress({ completed: true, step: 'business_info' });
    expect(progress.every((entry) => entry.status === 'done')).toBe(true);
  });

  it('splits the list into done, current and to-do around the stored step', () => {
    // Written against the list's own length rather than a fixed array of four: the steps are
    // product content and they grew in step 10, which broke this assertion without anything about
    // the function having changed.
    const index = 2;
    const progress = onboardingProgress({ completed: false, step: ONBOARDING_STEPS[index]!.key });
    expect(progress).toHaveLength(ONBOARDING_STEPS.length);
    expect(progress.map((entry) => entry.status)).toEqual([
      ...Array.from({ length: index }, () => 'done'),
      'current',
      ...Array.from({ length: ONBOARDING_STEPS.length - index - 1 }, () => 'todo'),
    ]);
  });

  it('offers three concrete next actions once setup is finished (FR-ONB-3)', () => {
    // "Your CRM is ready" with nothing to click is where a trial goes to die.
    expect(NEXT_ACTIONS).toHaveLength(3);
    for (const action of NEXT_ACTIONS) {
      expect(action.href.startsWith('/')).toBe(true);
      expect(action.description.length).toBeGreaterThan(20);
    }
  });

  it('has a step for choosing an industry, which is what a template needs', () => {
    expect(ONBOARDING_STEPS.map((step) => step.key)).toContain('industry');
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
