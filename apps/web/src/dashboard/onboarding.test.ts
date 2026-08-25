import { describe, expect, it } from 'vitest';
import { onboardingProgress, onboardingSteps } from './onboarding.js';

const NOBODY = { signedIn: false, savedBuilds: 0, pairedWorlds: 0 };

describe('onboardingSteps', () => {
  it('ticks nothing for a visitor with no account', () => {
    expect(onboardingSteps(NOBODY).every((step) => !step.done)).toBe(true);
  });

  it('sends every unfinished step somewhere it can actually be done', () => {
    for (const step of onboardingSteps(NOBODY)) {
      expect(step.href).toBeTruthy();
      expect(step.action).toBeTruthy();
    }
  });

  it('drops the link once a step is finished', () => {
    const steps = onboardingSteps({
      signedIn: true,
      savedBuilds: 2,
      pairedWorlds: 1,
    });
    expect(steps.map((step) => step.href)).toEqual([null, null, null]);
  });

  it('does not tick "save a build" for an account that has none', () => {
    const steps = onboardingSteps({ ...NOBODY, signedIn: true });
    expect(steps.find((step) => step.id === 'build')?.done).toBe(false);
  });

  it('treats a paired world as proof the mod is installed', () => {
    const steps = onboardingSteps({
      signedIn: true,
      savedBuilds: 1,
      pairedWorlds: 1,
    });
    expect(steps.find((step) => step.id === 'world')?.done).toBe(true);
  });
});

describe('onboardingProgress', () => {
  it('counts what is done and points at the first thing that is not', () => {
    const progress = onboardingProgress(
      onboardingSteps({ signedIn: true, savedBuilds: 0, pairedWorlds: 0 }),
    );
    expect(progress).toMatchObject({ done: 1, total: 3, complete: false });
    expect(progress.next?.id).toBe('build');
  });

  it('reports completion with nothing left to point at', () => {
    const progress = onboardingProgress(
      onboardingSteps({ signedIn: true, savedBuilds: 1, pairedWorlds: 1 }),
    );
    expect(progress).toMatchObject({
      done: 3,
      total: 3,
      complete: true,
      next: null,
    });
  });

  // The order is the path: an account, then something to build, then somewhere to build it.
  // A checklist that offers step three first is a checklist nobody finishes.
  it('keeps the steps in the order they have to happen', () => {
    expect(onboardingSteps(NOBODY).map((step) => step.id)).toEqual(['account', 'build', 'world']);
  });
});
